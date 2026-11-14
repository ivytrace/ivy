import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authenticate } from './lib/auth/middleware.js';
import { serveUi } from './lib/static/serve-ui.js';
import { singleTenantResolver, tenantContext, type TenantResolver } from './lib/tenancy/context.js';
import { deleteAwsAccount } from './routes/aws/accounts/delete.js';
import { getAwsAccount, getAwsAccounts } from './routes/aws/accounts/get.js';
import { patchAwsAccount } from './routes/aws/accounts/patch.js';
import { postAwsAccount } from './routes/aws/accounts/post.js';
import { syncAwsAccount } from './routes/aws/accounts/sync.js';
import { verifyAwsAccount } from './routes/aws/accounts/verify.js';
import { postAwsEvent } from './routes/aws/events.js';
import { getAwsFunctions } from './routes/aws/functions/get.js';
import { putAwsFunction } from './routes/aws/functions/put.js';
import { getAwsSetup } from './routes/aws/setup.js';
import { getAwsTemplate } from './routes/aws/template.js';
import { getConfig } from './routes/config/get.js';
import { getErrors } from './routes/errors/get.js';
import { getFunctions } from './routes/functions/get.js';
import { getHealth } from './routes/health/get.js';
import { getInvocations } from './routes/invocations/get.js';
import { getTimeseries } from './routes/stats/timeseries.js';
import { getTrace } from './routes/traces/get.js';

export function createApp(options: { uiDir: string; tenants?: TenantResolver }) {
  const app = new Hono();

  app.use('/api/*', authenticate());
  // Routes without a tenant: registered before the tenant middleware so it never runs for them.
  app.get('/api/health', getHealth);
  app.get('/api/config', getConfig);
  app.post('/api/aws/events', postAwsEvent);

  app.use('/api/*', tenantContext(options.tenants ?? singleTenantResolver()));
  app.get('/api/functions', getFunctions);
  app.get('/api/invocations', getInvocations);
  app.get('/api/traces/:traceId', getTrace);
  app.get('/api/errors', getErrors);
  app.get('/api/stats/timeseries', getTimeseries);
  app.get('/api/aws/setup', getAwsSetup);
  app.get('/api/aws/template.yaml', getAwsTemplate);
  app.get('/api/aws/accounts', getAwsAccounts);
  app.post('/api/aws/accounts', postAwsAccount);
  app.get('/api/aws/accounts/:id', getAwsAccount);
  app.patch('/api/aws/accounts/:id', patchAwsAccount);
  app.delete('/api/aws/accounts/:id', deleteAwsAccount);
  app.post('/api/aws/accounts/:id/verify', verifyAwsAccount);
  app.post('/api/aws/accounts/:id/sync', syncAwsAccount);
  app.get('/api/aws/functions', getAwsFunctions);
  app.put('/api/aws/functions/:accountId/:region/:name', putAwsFunction);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use('*', serveUi(options.uiDir));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
