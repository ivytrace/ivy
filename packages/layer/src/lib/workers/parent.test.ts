import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker as OriginalWorker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import type { OtlpSpan } from '../export/otlp.js';
import { Tracer, type SpanBatch } from '../tracer/tracer.js';
import { wrapHandler } from '../tracer/wrap.js';
import { instrumentWorkerThreads, rejectedFlags, workerName } from './parent.js';

const dir = mkdtempSync(join(tmpdir(), 'ivy-workers-'));
const batches: SpanBatch[] = [];
const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://x' }), (b) => batches.push(b));
let server: Server;
let url = '';
let wt: typeof import('node:worker_threads');

const fixture = (name: string, code: string) => {
  const file = join(dir, name);
  writeFileSync(file, code);
  return file;
};

beforeAll(async () => {
  await build({ bundle: true, platform: 'node', format: 'cjs', entryPoints: [join(import.meta.dirname, '../../worker.ts')], outfile: join(dir, 'worker.cjs'), logLevel: 'warning' });
  server = createServer((_req, res) => res.end('{"ok":true}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/items`;
  instrumentWorkerThreads(tracer, join(dir, 'worker.cjs'))();
  wt = process.getBuiltinModule('node:worker_threads');
});

afterAll(() => server?.close());

async function invoke(fn: () => Promise<unknown>) {
  batches.length = 0;
  const handler = wrapHandler(tracer, fn);
  await handler({}, { awsRequestId: `req-${Math.random()}`, functionName: 'fn', getRemainingTimeInMillis: () => 30_000 });
  await new Promise((r) => setImmediate(r));
  const spans = batches.flatMap((b) => b.spans);
  const attr = (s: OtlpSpan, key: string) => {
    const v = s.attributes.find((a) => a.key === key)?.value as Record<string, unknown> | undefined;
    return v && Object.values(v)[0];
  };
  return { root: spans[0], children: spans.slice(1), attr };
}

const runToExit = (worker: InstanceType<typeof OriginalWorker>) => new Promise<number>((resolve) => worker.on('exit', resolve));

describe('worker threads', () => {
  it('nests the spans and logs of a worker under a span for the worker', async () => {
    const file = fixture(
      'job.mjs',
      `import { parentPort, workerData } from 'node:worker_threads'; const r = await fetch(workerData.url); console.log('fetched', r.status); parentPort.postMessage('done');`,
    );
    const messages: unknown[] = [];
    const { root, children, attr } = await invoke(() => {
      const worker = new wt.Worker(file, { workerData: { url } });
      worker.on('message', (m) => messages.push(m));
      return runToExit(worker);
    });

    const worker = children.find((s) => s.name === 'worker job.mjs')!;
    const call = children.find((s) => s.name.startsWith('GET'))!;
    expect(worker).toBeDefined();
    expect(worker.parentSpanId).toBe(root.spanId);
    expect(attr(worker, 'process.exit.code')).toBe('0');
    expect(attr(worker, 'code.file.path')).toBe(file);
    expect(call).toBeDefined();
    expect(call.traceId).toBe(root.traceId);
    expect(call.parentSpanId).toBe(worker.spanId);
    expect(root.events.some((e) => e.attributes.some((a) => a.key === 'log.message' && (a.value as any).stringValue === 'fetched 200'))).toBe(true);
    expect(messages).toEqual(['done']);
  });

  it('does not trace workers started by a worker, so their messages reach the app unchanged', async () => {
    const inner = fixture('inner.mjs', `import { parentPort, workerData } from 'node:worker_threads'; await fetch(workerData.url); parentPort.postMessage('inner done');`);
    const outer = fixture(
      'outer.mjs',
      `import { Worker, parentPort, workerData } from 'node:worker_threads';
       const seen = [];
       const w = new Worker(${JSON.stringify(inner)}, { workerData });
       w.on('message', (m) => seen.push(m));
       w.on('exit', () => parentPort.postMessage(seen));`,
    );
    const messages: unknown[] = [];
    const { children } = await invoke(() => {
      const worker = new wt.Worker(outer, { workerData: { url } });
      worker.on('message', (m) => messages.push(m));
      return runToExit(worker);
    });
    expect(messages).toEqual([['inner done']]);
    expect(children.map((s) => s.name)).toEqual(['worker outer.mjs']);
  });

  it('keeps spans of a worker that calls process.exit() and marks the exit as failed', async () => {
    const file = fixture('cancel.mjs', `import { workerData } from 'node:worker_threads'; await fetch(workerData.url); process.exit(130);`);
    const { children, attr } = await invoke(() => runToExit(new wt.Worker(file, { workerData: { url } })));

    const worker = children.find((s) => s.name === 'worker cancel.mjs')!;
    expect(attr(worker, 'process.exit.code')).toBe('130');
    expect(worker.status).toMatchObject({ code: 2, message: 'Worker exited with code 130' });
    expect(children.find((s) => s.name.startsWith('GET'))?.parentSpanId).toBe(worker.spanId);
  });

  it('attaches spans of a pool worker started outside the invocation to the invocation', async () => {
    const file = fixture(
      'pool.mjs',
      `import { parentPort } from 'node:worker_threads';
       parentPort.on('message', async (u) => { const r = await fetch(u); parentPort.postMessage(r.status); });`,
    );
    const pool = new wt.Worker(file);
    try {
      const { root, children } = await invoke(
        () =>
          new Promise((resolve) => {
            pool.once('message', resolve);
            pool.postMessage(url);
          }),
      );
      const call = children.find((s) => s.name.startsWith('GET'));
      expect(call?.parentSpanId).toBe(root.spanId);
      expect(children.some((s) => s.name.startsWith('worker'))).toBe(false);
    } finally {
      await pool.terminate();
    }
  });

  it('leaves the Worker class and its events as the app knows them', () => {
    const worker = new wt.Worker('setTimeout(() => {}, 1)', { eval: true });
    expect(worker).toBeInstanceOf(wt.Worker);
    expect(worker).toBeInstanceOf(OriginalWorker);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
    return runToExit(worker);
  });

  it("throws the app's own error for execArgv a worker rejects", () => {
    expect(() => new wt.Worker('0', { eval: true, execArgv: ['--max-old-space-size=100'] })).toThrow(/invalid execArgv flags: --max-old-space-size=100$/);
  });
});

describe('rejectedFlags', () => {
  it('reads the flags from ERR_WORKER_INVALID_EXEC_ARGV', () => {
    const err = Object.assign(new Error('Initiated Worker with invalid execArgv flags: --expose-gc, --max-semi-space-size=50'), { code: 'ERR_WORKER_INVALID_EXEC_ARGV' });
    expect(rejectedFlags(err)).toEqual(['--expose-gc', '--max-semi-space-size=50']);
    expect(rejectedFlags(new Error('other'))).toBeUndefined();
  });
});

describe('workerName', () => {
  it('names the worker after its name option, file or eval', () => {
    expect(workerName('/var/task/jobs/run.mjs', undefined)).toBe('worker run.mjs');
    expect(workerName(new URL('file:///var/task/run.mjs'), undefined)).toBe('worker run.mjs');
    expect(workerName('x', { eval: true })).toBe('worker (eval)');
    expect(workerName('/var/task/run.mjs', { name: 'resize' })).toBe('worker resize');
    expect(workerName(new URL('data:text/javascript,0'), undefined)).toBe('worker');
  });
});
