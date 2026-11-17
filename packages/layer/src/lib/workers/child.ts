import { loadConfig } from '../config/config.js';
import { instrumentAwsSdk } from '../instrumentation/aws-sdk.js';
import { instrumentConsole } from '../instrumentation/console.js';
import { instrumentFetch } from '../instrumentation/fetch.js';
import { instrumentHttp } from '../instrumentation/http.js';
import { installOtelBridge } from '../otel-bridge/index.js';
import { PayloadBudget } from '../tracer/payload-budget.js';
import type { Span } from '../tracer/span.js';
import { Tracer } from '../tracer/tracer.js';
import { TRACED_KEY, type WorkerBatch } from './protocol.js';

const FLUSH_INTERVAL_MS = 500;

/**
 * Runs in a worker thread before its own code (loaded with `--require`). Instruments the worker like a
 * function, with one standing invocation whose children are posted to the tracing thread: every
 * FLUSH_INTERVAL_MS, before every message the worker posts (so they arrive ahead of a pool worker's
 * "task done"), and on exit.
 */
export function traceWorkerThread(): void {
  const wt = process.getBuiltinModule('node:worker_threads') as any;
  const port = wt.parentPort;
  if (wt.getEnvironmentData(TRACED_KEY) !== true || !port) return;
  wt.setEnvironmentData(TRACED_KEY, undefined);

  const config = loadConfig();
  const tracer = new Tracer(config, () => {});
  const checkHttps = instrumentHttp(tracer);
  instrumentFetch(tracer);
  instrumentAwsSdk(tracer);
  if (config.captureLogs) instrumentConsole(tracer);
  installOtelBridge(tracer);
  const inv = tracer.startInvocation({}, {});

  const postMessage = wt.MessagePort.prototype.postMessage;
  const unlimited = new PayloadBudget(Infinity);
  let flushing = false;

  /**
   * `ended`: spans that have ended. `snapshot`: also copies of open spans, which stay here and are sent
   * again when they end (the tracing thread updates them in place). `all`: every span, on exit.
   */
  const flush = (mode: 'ended' | 'snapshot' | 'all') => {
    if (flushing) return;
    flushing = true;
    try {
      checkHttps();
      const ended: Span[] = [];
      const open: Span[] = [];
      for (const span of inv.children) (span.endMs === undefined && mode !== 'all' ? open : ended).push(span);
      const snapshots = mode === 'snapshot' ? open.map(snapshot) : [];
      if (!ended.length && !snapshots.length && !inv.root.events.length) return;
      inv.children = open;
      // Payloads become attributes here (functions and class instances can't be posted); the tracing
      // thread applies the invocation's payload budget to them.
      for (const span of ended) tracer.applyPayloads(span, unlimited);
      const batch: WorkerBatch = {
        ivyWorkerBatch: 1,
        root: inv.root.spanId,
        spans: [...ended, ...snapshots],
        logs: inv.root.events.splice(0),
      };
      inv.logCount = 0;
      postMessage.call(port, batch);
    } catch {
      // never affect the worker
    } finally {
      flushing = false;
    }
  };

  setInterval(() => flush('ended'), FLUSH_INTERVAL_MS).unref();
  process.on('exit', () => flush('all'));
  wt.MessagePort.prototype.postMessage = function (this: unknown, ...args: unknown[]) {
    flush('snapshot');
    return postMessage.apply(this, args);
  };
}

const snapshot = (span: Span): Span => ({ ...span, attributes: { ...span.attributes }, events: [...span.events], payloads: [], finalize: undefined });
