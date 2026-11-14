// Local end-to-end test: runs the example handlers in the official Lambda Node.js 22 image
// (Runtime Interface Emulator) with the built layer mounted at /opt, then checks the spans.
//
//   pnpm --filter @ivy/layer e2e
//   IVY_ENDPOINT=http://host.docker.internal:4318 IVY_API_KEY=dev-ingest-key pnpm --filter @ivy/layer e2e
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { startCaptureServer } from './capture-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.IVY_E2E_IMAGE ?? 'public.ecr.aws/lambda/nodejs:22';
const CAPTURE_PORT = Number(process.env.IVY_E2E_CAPTURE_PORT ?? 4399);
const externalEndpoint = process.env.IVY_ENDPOINT;
const endpoint = externalEndpoint ?? `http://host.docker.internal:${CAPTURE_PORT}`;
const apiKey = process.env.IVY_API_KEY ?? 'dev-ingest-key';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();

console.log('building layer…');
execFileSync('node', [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
const opt = join(root, 'dist/e2e-opt');
rmSync(opt, { recursive: true, force: true });
mkdirSync(opt, { recursive: true });
run('unzip', ['-q', join(root, 'dist/layer.zip'), '-d', opt]);

const bundledDir = join(root, 'dist/e2e-bundled');
await esbuild.build({
  entryPoints: [join(root, 'example/bundled/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(bundledDir, 'index.js'),
  logLevel: 'warning',
});

const capture = await startCaptureServer({ port: CAPTURE_PORT, apiKey });
// Fake upstreams (echo, DynamoDB) on a separate port: calls to the Ivy endpoint itself are never traced.
const upstream = await startCaptureServer({ port: CAPTURE_PORT - 1 });

const containers = [];
const logs = new Map();
function startContainer(name, port, taskDir, handler, extraEnv = {}, { layer = true } = {}) {
  const cname = `ivy-e2e-${name}-${process.pid}`;
  const env = {
    AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper',
    IVY_ENDPOINT: endpoint,
    IVY_API_KEY: apiKey,
    IVY_DEBUG: '1',
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret',
    AWS_LAMBDA_FUNCTION_NAME: `ivy-e2e-${name}`,
    ECHO_URL: `http://host.docker.internal:${CAPTURE_PORT - 1}`,
    ...extraEnv,
  };
  const args = ['run', '-d', '--rm', '--name', cname, '-p', `${port}:8080`, '--add-host=host.docker.internal:host-gateway'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  if (layer) args.push('-v', `${opt}:/opt:ro`);
  args.push('-v', `${taskDir.startsWith('/') ? taskDir : join(root, 'example', taskDir)}:/var/task:ro`, IMAGE, handler);
  run('docker', args);
  containers.push(cname);
  const proc = spawn('docker', ['logs', '-f', cname]);
  const buf = [];
  proc.stdout.on('data', (d) => buf.push(d.toString()));
  proc.stderr.on('data', (d) => buf.push(d.toString()));
  logs.set(name, buf);
  return port;
}

async function invoke(port, event) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}/2015-03-31/functions/function/invocations`, {
        method: 'POST',
        body: JSON.stringify(event),
      });
      const body = await res.text();
      return { ms: Date.now() - started, status: res.status, body, finishedAt: Date.now() };
    } catch (err) {
      if (attempt > 50) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const apiGwV2 = {
  version: '2.0',
  routeKey: 'POST /orders/{id}',
  rawPath: '/orders/123',
  rawQueryString: 'x=1',
  headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
  requestContext: { http: { method: 'POST', path: '/orders/123' }, domainName: 'abc.execute-api.eu-west-1.amazonaws.com', requestId: 'r1' },
  body: '{"password":"p"}',
};
const sqs = {
  Records: [
    { messageId: 'm-1', eventSource: 'aws:sqs', eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:orders-queue', body: '{}' },
  ],
};
const scheduled = { source: 'aws.events', 'detail-type': 'Scheduled Event', resources: ['arn:aws:events:eu-west-1:1:rule/nightly'], detail: {} };

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`);
  if (!ok) failed = true;
};

try {
  const cjs = startContainer('cjs', 9101, 'cjs', 'index.handler');
  const cb = startContainer('callback', 9102, 'cjs', 'index.callbackHandler');
  const esm = startContainer('esm', 9103, 'esm', 'index.handler');
  const slow = startContainer('timeout', 9104, 'cjs', 'index.handler', { AWS_LAMBDA_FUNCTION_TIMEOUT: '2' });
  const broken = startContainer('unreachable', 9105, 'cjs', 'index.handler', { IVY_ENDPOINT: 'http://host.docker.internal:1' });
  const bundled = startContainer('bundled', 9107, bundledDir, 'index.handler');
  const baseline = startContainer('baseline', 9106, 'cjs', 'index.handler', { AWS_LAMBDA_EXEC_WRAPPER: '', IVY_ENDPOINT: '' }, { layer: false });

  console.log('invoking…');
  const results = {
    cold: await invoke(cjs, apiGwV2),
    warm: await invoke(cjs, apiGwV2),
    error: await invoke(cjs, { fail: true }),
    sqs: await invoke(cjs, sqs),
    callback: await invoke(cb, scheduled),
    esm: await invoke(esm, sqs),
    bundled: await invoke(bundled, {}),
    timeout: await invoke(slow, { sleepMs: 4000 }),
  };
  for (const [k, r] of Object.entries(results)) console.log(`  ${k.padEnd(9)} ${String(r.ms).padStart(5)}ms  ${r.body.slice(0, 110)}`);

  check(JSON.parse(results.warm.body).statusCode === 200, 'handler result passed through unchanged');
  check(/Intentional failure/.test(results.error.body), 'handler error propagated unchanged');
  check(JSON.parse(results.callback.body).ok === true, 'callback-style handler result passed through');
  check(JSON.parse(results.esm.body).ok === true, 'ESM handler result passed through');

  const brokenRuns = [];
  for (let i = 0; i < 3; i++) brokenRuns.push(await invoke(broken, apiGwV2));
  check(brokenRuns.every((r) => JSON.parse(r.body).statusCode === 200), `unreachable endpoint: results unchanged (${brokenRuns.map((r) => r.ms + 'ms').join(', ')})`);

  await invoke(baseline, apiGwV2);
  const median = async (port, n = 25) => {
    const times = [];
    for (let i = 0; i < n; i++) times.push((await invoke(port, apiGwV2)).ms);
    return times.sort((a, b) => a - b)[Math.floor(n / 2)];
  };
  const tracedMs = await median(cjs);
  const baselineMs = await median(baseline);
  // The emulator only answers once extensions are done, so client latency includes the post-response
  // export. RTDONE marks when the runtime posted the response, which is what callers see on real Lambda.
  await new Promise((r) => setTimeout(r, 500));
  const rtdone = (name) => {
    const ds = logs.get(name).join('').match(/RTDONE\(status: success[^)]*duration: ([\d.]+)ms/g) ?? [];
    const v = ds.map((l) => parseFloat(l.match(/duration: ([\d.]+)ms/)[1])).slice(-25).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  console.log(`  warm median runtime duration (response posted): traced ${rtdone('cjs')}ms vs. no layer ${rtdone('baseline')}ms`);
  const init = (name) => logs.get(name).join('').match(/INIT REPORT\(durationMs: ([\d.]+)\)/)?.[1];
  console.log(`  init duration (cold start, single sample): traced ${init('cjs')}ms vs. no layer ${init('baseline')}ms`);
  console.log(`  warm median emulator round trip (incl. extension flush): traced ${tracedMs}ms vs. no layer ${baselineMs}ms`);

  if (externalEndpoint) {
    console.log(`\nspans were sent to ${externalEndpoint}; check the collector / UI.`);
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    const roots = () => capture.spans().filter((s) => s.attributes.some((a) => a.key === 'ivy.invocation'));
    const arrived = await capture.waitFor(() => roots().length >= 8, 20000);
    check(arrived, `received ${roots().length}/8+ invocation spans`);
    const spans = capture.spans();
    const attr = (s, k) => {
      const v = s.attributes.find((a) => a.key === k)?.value;
      if (!v) return undefined;
      if ('arrayValue' in v) return v.arrayValue.values.map((x) => Object.values(x)[0]);
      return Object.values(v)[0];
    };
    const rootsBy = (fn) => roots().filter((s) => s.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === `ivy-e2e-${fn}`));

    const cjsRoots = rootsBy('cjs');
    const http = cjsRoots.find((s) => attr(s, 'ivy.trigger.source') === 'aws:apigatewayv2' && attr(s, 'faas.coldstart') === true);
    check(!!http, 'API GW v2 invocation span (cold start) received');
    if (http) {
      check(/^[0-9a-f]{32}$/.test(http.traceId) && Math.abs(parseInt(http.traceId.slice(0, 8), 16) - Date.now() / 1000) < 600, `trace id has timestamp prefix (${http.traceId})`);
      check(http.kind === 2 && attr(http, 'http.route') === '/orders/{id}' && attr(http, 'http.response.status_code') === '200', 'SERVER kind, http.route, status code');
      check(/\[redacted\]/.test(attr(http, 'ivy.payload.request')) && !/secret-token/.test(attr(http, 'ivy.payload.request')), 'event payload captured with redaction');
      check(http.events.some((e) => e.name === 'log'), 'console logs captured as span events');
      const children = spans.filter((s) => s.parentSpanId === http.spanId);
      const fetchSpan = children.find((s) => attr(s, 'url.full')?.includes('/echo?api_key'));
      check(!!fetchSpan && fetchSpan.name.startsWith('POST ') && attr(fetchSpan, 'http.response.status_code') === '200', 'fetch span');
      check(!!fetchSpan && /api_key=%5Bredacted%5D/.test(attr(fetchSpan, 'url.full')) && /\[redacted\]/.test(attr(fetchSpan, 'ivy.payload.request')) && !!attr(fetchSpan, 'ivy.payload.response'), 'fetch payloads + query/body redaction');
      check(!!fetchSpan && /"authorization":"\[redacted\]"/.test(attr(fetchSpan, 'ivy.http.request.headers')), 'fetch header redaction');
      const httpSpan = children.find((s) => attr(s, 'url.full')?.includes('via=http'));
      check(!!httpSpan && httpSpan.name.startsWith('GET ') && /"method":"GET"/.test(attr(httpSpan, 'ivy.payload.response') ?? ''), 'node:http span with response body');
      const ddb = children.find((s) => s.name === 'DynamoDB.GetItem');
      check(!!ddb && attr(ddb, 'rpc.system') === 'aws-api' && attr(ddb, 'aws.dynamodb.table_names')?.[0] === 'users' && attr(ddb, 'aws.request_id') === 'FAKE-REQ-1' && attr(ddb, 'cloud.region') === 'eu-west-1', 'AWS SDK span (runtime-provided SDK, CJS)');
      check(!!ddb && /Ada/.test(attr(ddb, 'ivy.payload.response')) && /\[redacted\]/.test(attr(ddb, 'ivy.payload.response')), 'AWS SDK response payload with redaction');
      check(!children.some((s) => attr(s, 'url.full')?.includes('/dynamodb')), 'no duplicate HTTP span for SDK call');
    }
    const warm = cjsRoots.find((s) => attr(s, 'ivy.trigger.source') === 'aws:apigatewayv2' && attr(s, 'faas.coldstart') === false);
    check(!!warm, 'warm invocation marked faas.coldstart=false');
    const err = cjsRoots.find((s) => attr(s, 'error.type') === 'Error');
    check(!!err && err.status.code === 2 && err.events.some((e) => e.name === 'exception'), 'error span with exception event');
    check(cjsRoots.some((s) => attr(s, 'ivy.trigger.source') === 'aws:sqs' && s.kind === 5), 'SQS trigger (CONSUMER)');
    const cbRoot = rootsBy('callback')[0];
    check(!!cbRoot && attr(cbRoot, 'ivy.trigger.source') === 'aws:scheduled' && /"ok":true/.test(attr(cbRoot, 'ivy.payload.response') ?? ''), 'callback handler: scheduled trigger + response');
    const esmRoot = rootsBy('esm')[0];
    const esmDdb = esmRoot && spans.find((s) => s.parentSpanId === esmRoot.spanId && s.name === 'DynamoDB.PutItem');
    check(!!esmRoot && !!esmDdb && esmDdb.status.code === 2 && attr(esmDdb, 'http.response.status_code') === '400', 'ESM handler: failed DynamoDB call recorded as error span');
    const bundledRoot = rootsBy('bundled')[0];
    const bundledDdb = bundledRoot && spans.find((s) => s.parentSpanId === bundledRoot.spanId);
    check(
      !!bundledDdb && bundledDdb.name === 'DynamoDB.GetItem' && attr(bundledDdb, 'rpc.service') === 'DynamoDB' && attr(bundledDdb, 'aws.dynamodb.table_names')?.[0] === 'bundled-table' && attr(bundledDdb, 'aws.request_id') === 'FAKE-REQ-1',
      'bundled SDK: AWS span derived from the signed HTTP request',
    );
    const timeoutRoot = rootsBy('timeout')[0];
    check(!!timeoutRoot && attr(timeoutRoot, 'error.type') === 'Timeout', 'timeout recorded with error.type=Timeout');

    const latest = (fn) => Math.min(...rootsBy(fn).map((s) => s.receivedAt));
    console.log(`\n  spans for first cjs invocation arrived ${latest('cjs') - results.cold.finishedAt}ms after the response`);
    console.log(`  exports received: ${capture.exports.length}, spans: ${spans.length}`);
    if (process.env.IVY_E2E_DUMP) console.log(JSON.stringify(capture.exports.map((e) => e.payload), null, 2));
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  if (failed || process.env.IVY_E2E_LOGS) {
    for (const [name, buf] of logs) console.log(`\n--- container logs: ${name} ---\n${buf.join('')}`);
  }
  for (const c of containers) {
    try {
      run('docker', ['rm', '-f', c]);
    } catch {
      // already gone
    }
  }
  await capture.close();
  await upstream.close();
}
console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
process.exit(failed ? 1 : 0);
