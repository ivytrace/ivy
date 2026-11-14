import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { effectiveLimits } from '../../../lib/limits/limits.js';
import { parseMonth, usageBody, workspaceUsage } from '../../../lib/limits/present.js';
import { limitsStore } from '../../../lib/limits/store.js';
import { countMonthlyTracesAllTenants } from '../../../lib/limits/usage.js';
import { tenancyStore, type TenantRecord } from '../../../lib/tenancy/store.js';

export async function findWorkspace(c: Context): Promise<TenantRecord> {
  const tenant = await tenancyStore().getTenant(c.req.param('id') ?? '');
  if (!tenant) throw new HTTPException(404, { message: 'Workspace not found' });
  return tenant;
}

/**
 * `GET /internal/workspaces?month=YYYY-MM[&limits=unset]`: every workspace with its traces in the month and
 * its limits; `limits=unset` keeps only workspaces without a limits row.
 */
export async function getInternalWorkspaces(c: Context) {
  const now = Date.now();
  const month = parseMonth(c.req.query('month'), now);
  const [tenants, rows, traces] = await Promise.all([
    tenancyStore().listTenants(),
    limitsStore().list(),
    countMonthlyTracesAllTenants(month, now),
  ]);
  const limitsByTenant = new Map(rows.map((r) => [r.tenant_id, r]));
  const onlyUnset = c.req.query('limits') === 'unset';
  return c.json({
    month,
    items: tenants
      .filter((t) => !onlyUnset || !limitsByTenant.has(t.id))
      .map((t) => ({
        name: t.name,
        ...usageBody(t.id, month, traces.get(t.id) ?? 0, effectiveLimits(limitsByTenant.get(t.id) ?? null)),
      })),
  });
}

/** `GET /internal/workspaces/:id?month=YYYY-MM`: one workspace's traces in the month and its limits. */
export async function getInternalWorkspace(c: Context) {
  const now = Date.now();
  const month = parseMonth(c.req.query('month'), now);
  const tenant = await findWorkspace(c);
  return c.json({ name: tenant.name, ...(await workspaceUsage({ id: tenant.id, shardId: tenant.shard_id }, month, { now })) });
}
