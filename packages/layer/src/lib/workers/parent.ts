import { onRequire } from '../instrumentation/require-hook.js';
import { now } from '../tracer/clock.js';
import { recordError, SpanKind, StatusCode, type Span } from '../tracer/span.js';
import type { Invocation, Tracer } from '../tracer/tracer.js';
import { isLoaded } from '../utils/builtins.js';
import { isWorkerBatch, TRACED_KEY, type WorkerBatch } from './protocol.js';

const PATCHED = Symbol.for('ivy.worker_threads.patched');

type WorkerOptions = { execArgv?: unknown; eval?: unknown; name?: unknown } | undefined;

/**
 * Traces work done in `worker_threads`: every new Worker loads `bootstrap` first (via `--require`), which
 * instruments the worker and posts its spans and logs on the worker's parentPort, where they are taken out
 * of the Worker's 'message' events before the app's listeners see them. Workers started during
 * an invocation get a span of their own that their spans nest under. `worker_threads` is patched only once
 * something loads it (loading it costs several ms): CommonJS requires through the require hook, ESM imports
 * through the returned check, which runs after the user handler is loaded and at the start of each invocation.
 */
export function instrumentWorkerThreads(tracer: Tracer, bootstrap: string): () => void {
  let patched = false;
  const patchNow = () => {
    patched = true;
    patchWorker(tracer, bootstrap);
  };
  onRequire((request) => {
    if (!patched && (request === 'worker_threads' || request === 'node:worker_threads')) patchNow();
  });
  return () => {
    if (!patched && isLoaded('worker_threads')) patchNow();
  };
}

function patchWorker(tracer: Tracer, bootstrap: string): void {
  const wt = process.getBuiltinModule('node:worker_threads') as any;
  if (wt[PATCHED]) return;
  Object.defineProperty(wt, PATCHED, { value: true });

  wt.setEnvironmentData(TRACED_KEY, true);
  const workers = new Map<number, { span: Span; inv: Invocation }>();

  const receive = (threadId: number, batch: WorkerBatch) => {
    const started = workers.get(threadId);
    // The invocation that started the worker, while it runs (Web Functions run several at once); else the current one.
    const inv = started && !started.inv.done ? started.inv : tracer.active;
    if (!inv || inv.done) return;
    const parent = started?.inv === inv ? started.span.spanId : inv.root.spanId;
    tracer.adopt(inv, batch.spans, batch.logs, batch.root, parent);
  };

  // The parent's flags minus those a Worker rejects (V8 and process-wide flags such as --max-old-space-size,
  // which the Lambda runtime always sets); Node only drops them silently when execArgv is left out.
  let inheritedArgv: string[] | undefined;

  const Original = wt.Worker;
  wt.Worker = new Proxy(Original, {
    construct(target, args: unknown[], newTarget) {
      const [filename, options] = args as [unknown, WorkerOptions];
      const own = Array.isArray(options?.execArgv) ? (options.execArgv as string[]) : undefined;
      const attempt = (execArgv: string[]) => Reflect.construct(target, [filename, { ...options, execArgv: [...execArgv, '--require', bootstrap] }, ...args.slice(2)], newTarget);

      let worker: any;
      try {
        worker = attempt(own ?? inheritedArgv ?? process.execArgv);
      } catch (e) {
        const rejected = !own && !inheritedArgv ? rejectedFlags(e) : undefined;
        if (rejected) {
          inheritedArgv = process.execArgv.filter((flag) => !rejected.includes(flag));
          try {
            worker = attempt(inheritedArgv);
          } catch {
            worker = undefined;
          }
        }
        // Untraced, exactly as the app asked for it (and with the app's own error if that fails too).
        worker ??= Reflect.construct(target, args, newTarget);
      }

      try {
        observe(worker, filename, options);
      } catch {
        // tracing is best effort
      }
      return worker;
    },
  });
  process.getBuiltinModule('node:module').syncBuiltinESMExports();

  function observe(worker: any, filename: unknown, options: WorkerOptions): void {
    const threadId: number = worker.threadId;
    const inv = tracer.active;
    const span = inv ? tracer.startChild(workerName(filename, options), SpanKind.INTERNAL) : undefined;
    if (inv && span) {
      span.attributes['thread.id'] = threadId;
      if (typeof options?.name === 'string' && options.name) span.attributes['thread.name'] = options.name;
      const file = filePath(filename, options);
      if (file) span.attributes['code.file.path'] = file;
      workers.set(threadId, { span, inv });
    }
    // Wrapping emit (rather than adding listeners) keeps an unhandled 'error' unhandled, as the app expects.
    // Node emits every message a worker posted before its 'exit'.
    const emit = worker.emit;
    worker.emit = function (this: unknown, event: string | symbol, ...rest: unknown[]) {
      if (event === 'message' && isWorkerBatch(rest[0])) {
        try {
          receive(threadId, rest[0]);
        } catch {
          // tracing is best effort
        }
        return true;
      }
      try {
        if (event === 'error' && span) recordError(span, rest[0], now());
        else if (event === 'exit') {
          workers.delete(threadId);
          if (span) endWorkerSpan(span, rest[0]);
        }
      } catch {
        // never affect the app's listeners
      }
      return emit.call(this, event, ...rest);
    };
  }
}

function endWorkerSpan(span: Span, code: unknown): void {
  span.endMs = now();
  if (typeof code !== 'number') return;
  span.attributes['process.exit.code'] = code;
  if (code !== 0 && span.status.code !== StatusCode.ERROR) span.status = { code: StatusCode.ERROR, message: `Worker exited with code ${code}` };
}

/** The flags named by an ERR_WORKER_INVALID_EXEC_ARGV error ("…invalid execArgv flags: --a, --b=1"). */
export function rejectedFlags(e: unknown): string[] | undefined {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code !== 'ERR_WORKER_INVALID_EXEC_ARGV' || typeof err.message !== 'string') return undefined;
  const list = err.message.split(': ').slice(1).join(': ');
  const flags = list.split(', ').filter(Boolean);
  return flags.length ? flags : undefined;
}

function filePath(filename: unknown, options: WorkerOptions): string | undefined {
  if (options?.eval) return undefined;
  if (filename instanceof URL) return filename.protocol === 'file:' ? decodeURIComponent(filename.pathname) : undefined;
  if (typeof filename !== 'string') return undefined;
  if (filename.startsWith('file:')) return decodeURIComponent(new URL(filename).pathname);
  return filename.includes(':') && !filename.startsWith('/') ? undefined : filename;
}

export function workerName(filename: unknown, options: WorkerOptions): string {
  if (typeof options?.name === 'string' && options.name) return `worker ${options.name}`;
  if (options?.eval) return 'worker (eval)';
  const file = filePath(filename, options);
  return file ? `worker ${file.split(/[\\/]/).pop()}` : 'worker';
}
