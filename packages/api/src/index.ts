import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { startSyncLoop } from './lib/aws/scheduler.js';
import { readAuthConfig } from './lib/auth/config.js';
import { ensureDefaultTenant } from './lib/tenancy/tenants.js';
import { retry } from './lib/utils/retry.js';

const auth = readAuthConfig();
console.log(auth ? `Auth: OIDC (${auth.issuer}, client ${auth.clientId})` : 'Auth: disabled (IVY_OIDC_ISSUER not set)');
const port = Number(process.env.PORT ?? 3000);
const uiDir = process.env.IVY_UI_DIR ?? path.resolve(process.cwd(), '../ui/dist');

await retry('bootstrap of the default tenant', () => ensureDefaultTenant());

serve({ fetch: createApp({ uiDir }).fetch, port }, (info) => {
  console.log(`Ivy API listening on :${info.port} (UI from ${uiDir})`);
});

startSyncLoop();
