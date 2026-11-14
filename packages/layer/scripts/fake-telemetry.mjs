// Fake Lambda Runtime API + Telemetry API source for the extension. The Runtime Interface Emulator answers
// telemetry subscriptions with "Telemetry API is not supported", so e2e.mjs runs this inside the Lambda image
// instead: it starts the real extension binary from /opt against a fake Extensions API, accepts its
// subscription, and replays what Lambda would deliver (platform events plus the function log lines the
// failing example handlers really printed in the emulator).
//
//   node fake-telemetry.mjs <fixtures.json>     fixtures: { importError: string[], oom: string[] }
//   node fake-telemetry.mjs --coldstart <runs>  time from spawn to the first /next, telemetry on vs. off
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const RUNTIME_PORT = 9001;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** One extension process against a fake Extensions/Telemetry API; the scenario drives /next. */
async function startExtension(env = {}) {
  const pendingNext = [];
  const events = [];
  let subscribedPort;
  let onNext;
  let firstNextAt;
  const nextCalled = () => new Promise((r) => (onNext = r));
  let nextWaiter = nextCalled();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.endsWith('/extension/register')) {
        res.writeHead(200, { 'lambda-extension-identifier': 'ext-1', 'content-type': 'application/json' });
        res.end(JSON.stringify({ functionName: 'checkout', functionVersion: '$LATEST', handler: 'index.handler', accountId: '123456789012' }));
      } else if (req.url.endsWith('/telemetry') && req.method === 'PUT') {
        const sub = JSON.parse(body);
        subscribedPort = Number(new URL(sub.destination.URI).port);
        events.push({ subscription: sub });
        res.writeHead(200).end('"OK"');
      } else if (req.url.endsWith('/extension/event/next')) {
        firstNextAt ??= performance.now();
        pendingNext.push(res);
        const done = onNext;
        nextWaiter = nextCalled();
        done?.();
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((r) => server.listen(RUNTIME_PORT, '127.0.0.1', r));
  const spawnedAt = performance.now();
  const proc = spawn('/opt/extensions/ivy-extension', [], {
    env: {
      ...process.env,
      AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${RUNTIME_PORT}`,
      AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper',
      AWS_LAMBDA_FUNCTION_NAME: 'ivy-e2e-telemetry',
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '128',
      AWS_REGION: 'eu-west-1',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exited = new Promise((r) => proc.on('exit', r));
  return {
    exited,
    subscription: () => events.find((e) => e.subscription)?.subscription,
    coldStartMs: async () => {
      await nextWaiter;
      return firstNextAt - spawnedAt;
    },
    async waitForNextCall() {
      while (!pendingNext.length) await nextWaiter;
    },
    /** Waits for the extension to ask for the next event, then hands it one. */
    async next(event) {
      while (!pendingNext.length) await nextWaiter;
      pendingNext.shift().writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(event));
    },
    async telemetry(list) {
      while (!subscribedPort) await sleep(5);
      return post(subscribedPort, '/', list.map(([type, record, time]) => ({ time: time ?? now(), type, record })));
    },
    async tracer(path, body) {
      for (let i = 0; ; i++) {
        try {
          return await post(9790, path, body);
        } catch (e) {
          if (i > 100) throw e;
          await sleep(5);
        }
      }
    },
    async close() {
      proc.kill('SIGKILL');
      await exited;
      for (const res of pendingNext) res.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

const deadline = () => Date.now() + 3000;
const fn = (line) => ['function', line];

async function initFailure(logLines) {
  const ext = await startExtension();
  await ext.telemetry([
    ['platform.initStart', { initializationType: 'on-demand', phase: 'init' }],
    ...logLines.map(fn),
    ['platform.initRuntimeDone', { initializationType: 'on-demand', phase: 'init', status: 'error', errorType: 'Runtime.ImportModuleError' }],
    ['platform.initReport', { initializationType: 'on-demand', phase: 'init', status: 'error', errorType: 'Runtime.ImportModuleError', metrics: { durationMs: 71.2 } }],
  ]);
  // Lambda resets the environment after a failed init; the extension gets SHUTDOWN.
  await ext.next({ eventType: 'SHUTDOWN', shutdownReason: 'failure', deadlineMs: Date.now() + 2000 });
  await ext.exited;
  await ext.close();
}

const rootSpan = (requestId, spanId, extra = {}) => ({
  traceId: `${Math.floor(Date.now() / 1000).toString(16)}${'ab'.repeat(12)}`,
  spanId,
  name: 'ivy-e2e-telemetry',
  kind: 1,
  startTimeUnixNano: `${Date.now()}000000`,
  endTimeUnixNano: `${Date.now() + 5}000000`,
  attributes: [
    { key: 'ivy.invocation', value: { boolValue: true } },
    { key: 'faas.invocation_id', value: { stringValue: requestId } },
  ],
  events: [],
  status: { code: 0 },
  ...extra,
});
const resource = [{ key: 'faas.name', value: { stringValue: 'ivy-e2e-telemetry' } }, { key: 'service.name', value: { stringValue: 'ivy-e2e-telemetry' } }];

async function outOfMemory(logLines) {
  const ext = await startExtension();
  await ext.tracer('/hello', {});
  await ext.telemetry([
    ['platform.initRuntimeDone', { phase: 'init', status: 'success' }],
    ['platform.initReport', { phase: 'init', status: 'success', metrics: { durationMs: 120.5 } }],
  ]);
  await ext.next({ eventType: 'INVOKE', requestId: 'oom-1', deadlineMs: deadline(), invokedFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:ivy-e2e-telemetry' });
  // Partial spans from before the crash (a provisional snapshot), then the process dies.
  const child = { ...rootSpan('oom-1', 'c0ffee0000000002'), name: 'DynamoDB.Scan', parentSpanId: 'c0ffee0000000001', kind: 3, attributes: [] };
  await ext.tracer('/spans', { requestId: 'oom-1', final: false, resource, spans: [rootSpan('oom-1', 'c0ffee0000000001'), child] });
  await ext.telemetry([
    ['platform.start', { requestId: 'oom-1' }],
    ...logLines.map(fn),
    ['platform.runtimeDone', { requestId: 'oom-1', status: 'failure', errorType: 'Runtime.ExitError', metrics: { durationMs: 95 } }],
  ]);
  await ext.next({ eventType: 'SHUTDOWN', shutdownReason: 'failure', deadlineMs: Date.now() + 2000 });
  await ext.telemetry([['platform.report', { requestId: 'oom-1', status: 'failure', metrics: { billedDurationMs: 96, durationMs: 95, maxMemoryUsedMB: 128, memorySizeMB: 128 } }]]);
  await ext.exited;
  await ext.close();
}

async function healthyWithReport() {
  const ext = await startExtension();
  await ext.tracer('/hello', {});
  await ext.telemetry([
    ['platform.initRuntimeDone', { phase: 'init', status: 'success' }],
    ['platform.initReport', { phase: 'init', status: 'success', metrics: { durationMs: 150.25 } }],
  ]);
  for (const [i, id] of ['ok-1', 'ok-2'].entries()) {
    await ext.next({ eventType: 'INVOKE', requestId: id, deadlineMs: deadline(), invokedFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:ivy-e2e-telemetry' });
    await ext.telemetry([['platform.start', { requestId: id }], fn(`${now()}\t${id}\tINFO\thandling order ${i}`)]);
    await ext.tracer('/spans', { requestId: id, final: true, resource, spans: [rootSpan(id, `00000000000000a${i}`)] });
    await ext.telemetry([['platform.runtimeDone', { requestId: id, status: 'success', metrics: { durationMs: 4.2 } }]]);
    // The report is emitted once the invoke phase is over, i.e. after the extension's /next.
    await ext.waitForNextCall();
    await ext.telemetry([['platform.report', { requestId: id, status: 'success', metrics: { billedDurationMs: 5 + i, durationMs: 4.2, maxMemoryUsedMB: 70 + i, memorySizeMB: 128 } }]]);
  }
  await ext.next({ eventType: 'SHUTDOWN', shutdownReason: 'spindown', deadlineMs: Date.now() + 2000 });
  await ext.exited;
  await ext.close();
}

async function coldStart(runs) {
  // Alternate the two variants so that load on the machine affects both alike.
  const times = { off: [], on: [] };
  for (let i = 0; i < runs * 2; i++) {
    const variant = i % 2 ? 'on' : 'off';
    const ext = await startExtension({ IVY_ENDPOINT: 'http://127.0.0.1:1', IVY_DEBUG: '', ...(variant === 'off' ? { IVY_PLATFORM_TELEMETRY: 'false' } : {}) });
    times[variant].push(await ext.coldStartMs());
    await ext.close();
  }
  const median = (v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
  console.log(JSON.stringify({ coldStart: { telemetryOffMs: median(times.off), telemetryOnMs: median(times.on) } }));
}

if (process.argv[2] === '--coldstart') {
  await coldStart(Number(process.argv[3] ?? 15));
} else {
  const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  await initFailure(fixtures.importError);
  await outOfMemory(fixtures.oom);
  await healthyWithReport();
}
process.exit(0);
