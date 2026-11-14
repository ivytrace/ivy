import type { IvyData } from '@ivy/mcp';
import type { ErrorGroup, Invocation, Trace } from '@ivy/spans';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getErrors } from '../../routes/errors/get.js';
import { getInvocations } from '../../routes/invocations/get.js';
import { getTrace } from '../../routes/traces/get.js';
import type { Tenant } from '../tenancy/context.js';
import type { ApiWorkspace, WorkspaceSource } from './workspaces.js';

/**
 * The API's own route handlers, run in-process (no HTTP) for one workspace's tenant. The MCP tools
 * therefore go through the same SQL, validation and tenant guard (dataQuery → that tenant's shard)
 * as the API, one tenant-scoped read per workspace; the fan-out over workspaces is in @ivy/mcp.
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

export function apiData(c: Context, workspaces: WorkspaceSource): IvyData<ApiWorkspace> {
  let resolved: Promise<ApiWorkspace[]> | undefined;
  return {
    workspaces: () => (resolved ??= workspaces(c)),
    async invocations(w, query) {
      const body = await call<{ items: Invocation[] }>(w.tenant, `/invocations${search({ ...query })}`);
      return body?.items ?? [];
    },
    trace: (w, traceId) => call<Trace>(w.tenant, `/traces/${encodeURIComponent(traceId)}`),
    async errors(w, query) {
      const body = await call<{ items: ErrorGroup[] }>(w.tenant, `/errors${search({ ...query })}`);
      return body?.items ?? [];
    },
  };
}
