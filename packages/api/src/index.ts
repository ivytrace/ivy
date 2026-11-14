import http from 'node:http';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { startSyncLoop } from './lib/aws/scheduler.js';
import { readAuthConfig } from './lib/auth/config.js';
import { hookStats } from './lib/hooks/run.js';
import { ensureDefaultTenant, ensureWorkspaceDefaults } from './lib/tenancy/tenants.js';
import { retry } from './lib/utils/retry.js';

const auth = readAuthConfig();
console.log(auth ? `Auth: OIDC (${auth.issuer}, client ${auth.clientId})` : 'Auth: disabled (IVY_OIDC_ISSUER not set)');
const port = Number(process.env.PORT ?? 3000);
const uiDir = process.env.IVY_UI_DIR ?? path.resolve(process.cwd(), '../ui/dist');

await retry('bootstrap of the default tenant', () => ensureDefaultTenant());
await retry('workspace slugs and default projects', () => ensureWorkspaceDefaults());

serve({ fetch: createApp({ uiDir }).fetch, port }, (info) => {
  console.log(`Ivy API listening on :${info.port} (UI from ${uiDir})`);
});

startSyncLoop();

// Internal only (loopback): counters of this API process, like the ingest router's /stats.
const adminPort = Number(process.env.IVY_API_ADMIN_PORT ?? 3020);
http
  .createServer((req, res) => {
    if (req.url === '/stats') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hooks: hookStats() }));
    else res.writeHead(404).end();
  })
  .listen(adminPort, process.env.IVY_API_ADMIN_HOST ?? '127.0.0.1');
