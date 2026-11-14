import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serveUi } from './lib/static/serve-ui.js';
import { getConfig } from './routes/config/get.js';
import { getErrors } from './routes/errors/get.js';
import { getFunctions } from './routes/functions/get.js';
import { getHealth } from './routes/health/get.js';
import { getInvocations } from './routes/invocations/get.js';
import { getTimeseries } from './routes/stats/timeseries.js';
import { getTrace } from './routes/traces/get.js';

export function createApp(options: { uiDir: string }) {
  const app = new Hono();

  app.get('/api/health', getHealth);
  app.get('/api/config', getConfig);
  app.get('/api/functions', getFunctions);
  app.get('/api/invocations', getInvocations);
  app.get('/api/traces/:traceId', getTrace);
  app.get('/api/errors', getErrors);
  app.get('/api/stats/timeseries', getTimeseries);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use('*', serveUi(options.uiDir));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
