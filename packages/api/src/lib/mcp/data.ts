import type { ErrorGroup, Invocation, Trace } from '@ivy/spans';
import type { IvyData } from '@ivy/mcp';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getErrors } from '../../routes/errors/get.js';
import { getInvocations } from '../../routes/invocations/get.js';
import { getTrace } from '../../routes/traces/get.js';
import { tenantOf, type Tenant } from '../tenancy/context.js';

/**
 * The API's own route handlers, run in-process (no HTTP) with the tenant the outer request resolved.
 * The MCP tools therefore go through the same SQL, validation and tenant guard (dataQuery) as the API.
 */
const routes = new Hono<{ Bindings: { tenant: Tenant } }>()
  .use(async (c, next) => {
    c.set('tenant', c.env.tenant);
    await next();
  })
  .get('/invocations', getInvocations)
  .get('/traces/:traceId', getTrace)
  .get('/errors', getErrors)
  .onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    throw err;
  });

function search(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return query.size ? `?${query}` : '';
}

async function call<T>(tenant: Tenant, path: string): Promise<T | null> {
  const res = await routes.request(path, {}, { tenant });
  if (res.status === 404) return null;
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function apiData(c: Context): IvyData {
  const tenant = tenantOf(c);
  return {
    async invocations(query) {
      const body = await call<{ items: Invocation[] }>(tenant, `/invocations${search({ ...query })}`);
      return body?.items ?? [];
    },
    async trace(traceId) {
      return call<Trace>(tenant, `/traces/${encodeURIComponent(traceId)}`);
    },
    async errors(query) {
      const body = await call<{ items: ErrorGroup[] }>(tenant, `/errors${search({ ...query })}`);
      return body?.items ?? [];
    },
  };
}
