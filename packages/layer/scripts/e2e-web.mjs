// Local end-to-end test for Lambda Web Functions: installs the web tracer package as node_modules/@ivytrace/lambda-web
// next to example/web, starts the app with NODE_OPTIONS=--import @ivytrace/lambda-web (as the README says), sends
// concurrent requests, then SIGTERM, and checks the exported spans. No Docker or AWS needed.
//
//   pnpm --filter @ivy/layer e2e:web
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { startCaptureServer } from './capture-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE_PORT = Number(process.env.IVY_E2E_CAPTURE_PORT ?? 4399);
const APP_PORT = Number(process.env.IVY_E2E_WEB_PORT ?? 4398);
const apiKey = 'dev-ingest-key';

// Inside packages/layer, so the app resolves @aws-sdk from the package's node_modules.
const app = join(root, 'dist/e2e-web');
const pkg = join(app, 'node_modules/@ivytrace/lambda-web');
rmSync(app, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
const common = { bundle: true, platform: 'node', target: 'node24', minify: true, legalComments: 'none', logLevel: 'warning' };
await esbuild.build({ ...common, entryPoints: [join(root, 'src/web.ts')], format: 'esm', outfile: join(pkg, 'index.mjs') });
await esbuild.build({ ...common, entryPoints: [join(root, 'src/worker.ts')], format: 'cjs', outfile: join(pkg, 'worker.cjs') });
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@ivytrace/lambda-web', type: 'module', exports: { '.': './index.mjs' } }));
copyFileSync(join(root, 'example/web/index.mjs'), join(app, 'index.mjs'));

const capture = await startCaptureServer({ port: CAPTURE_PORT, apiKey });
const proc = spawn(process.execPath, ['index.mjs'], {
  cwd: app,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: '--import @ivytrace/lambda-web',
    AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${APP_PORT}`,
    IVY_ENDPOINT: `http://127.0.0.1:${CAPTURE_PORT}`,
    IVY_API_KEY: apiKey,
    // Not the endpoint's host:port, which the tracer skips.
    ECHO_URL: `http://localhost:${CAPTURE_PORT}`,
  },
});
let output = '';
proc.stdout.on('data', (d) => (output += d));
proc.stderr.on('data', (d) => (output += d));
const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !output.includes('listening'); i++) await sleep(50);
if (!output.includes('listening')) throw new Error(`app did not start:\n${output}`);

const call = (path, requestId) =>
  fetch(`http://127.0.0.1:${APP_PORT}${path}`, { headers: { 'lambda-web-request-id': requestId, 'lambda-web-endpoint-name': 'orders' } }).then((r) => r.status);
const statuses = await Promise.all([call('/orders?id=1&wait=80', 'req-1'), call('/orders?id=2&wait=10', 'req-2'), call('/fail?id=3', 'req-3')]);
// The last request finishes right before SIGTERM: its spans go out in the shutdown flush.
await call('/orders?id=4', 'req-4');
proc.kill('SIGTERM');
const exit = await exited;
capture.close?.();

const attrs = (s) => Object.fromEntries(s.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
const spans = capture.exports.flatMap((e) => e.payload.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
const failures = [];
const check = (ok, message) => ok || failures.push(message);

check(statuses.join() === '200,200,500', `statuses ${statuses}`);
check(exit.signal === 'SIGTERM', `app should end on SIGTERM as without the tracer, got ${JSON.stringify(exit)}`);
for (const id of ['1', '2', '3', '4']) {
  const root = spans.find((s) => attrs(s)['faas.invocation_id'] === `req-${id}`);
  if (!check(root, `no invocation for req-${id}`)) continue;
  const a = attrs(root);
  check(a['ivy.trigger.source'] === 'aws:lambda-web', `req-${id}: trigger ${a['ivy.trigger.source']}`);
  check(root.name === 'orders', `req-${id}: name ${root.name}`);
  const children = spans.filter((s) => s.parentSpanId === root.spanId).map((s) => s.name).sort();
  const logs = root.events.filter((e) => e.name === 'log').map((e) => attrs(e)['log.message']);
  check(logs.join() === `order ${id}`, `req-${id}: logs ${JSON.stringify(logs)}`);
  if (id === '3') {
    check(a['http.response.status_code'] === '500' && root.status.code === 2, `req-3 should fail with 500`);
    check(children.length === 0, `req-3: children ${children}`);
  } else {
    check(children.join() === 'DynamoDB.GetItem,GET localhost', `req-${id}: children ${children}`);
  }
}
check(!spans.some((s) => s.name === 'POST 127.0.0.1' && attrs(s)['url.full']?.includes('/v1/traces')), 'export requests must not be traced');

if (failures.length) {
  console.error(`e2e-web failed:\n- ${failures.join('\n- ')}\n\napp output:\n${output}`);
  process.exit(1);
}
console.log(`e2e-web passed: ${spans.length} spans in ${capture.exports.length} export requests`);
process.exit(0);
