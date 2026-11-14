import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { shardClient } from '../clickhouse/client.js';
import { tenantQuery } from '../clickhouse/scoped.js';
import { tenancyStore } from './store.js';
import { DEFAULT_TENANT } from './tenants.js';

/** The tenant a request acts for, and the shard (cell) holding its span data. */
export interface Tenant {
  id: string;
  shardId: string;
}

/**
 * Maps a request to its tenant. Today there is no user auth, so every request is the `default`
 * tenant. With OIDC login this becomes: session → user → tenant membership (and a tenant picker).
 * Returning null answers 401.
 */
export interface TenantResolver {
  resolve(c: Context): Promise<Tenant | null>;
}

const TTL_MS = 30_000;
const shardCache = new Map<string, { tenant: Tenant | null; expires: number }>();

/** Tenant directory lookup (tenant → shard), cached briefly so moving a tenant takes effect within TTL_MS. */
export async function lookupTenant(id: string): Promise<Tenant | null> {
  const hit = shardCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.tenant;
  const record = await tenancyStore().getTenant(id);
  const tenant = record ? { id: record.id, shardId: record.shard_id } : null;
  shardCache.set(id, { tenant, expires: Date.now() + TTL_MS });
  return tenant;
}

export function clearTenantCacheForTests() {
  shardCache.clear();
}

export const singleTenantResolver = (id = DEFAULT_TENANT): TenantResolver => ({
  resolve: () => lookupTenant(id),
});

export function tenantContext(resolver: TenantResolver): MiddlewareHandler {
  return async (c, next) => {
    const tenant = await resolver.resolve(c);
    if (!tenant) throw new HTTPException(401, { message: 'Unauthorized' });
    c.set('tenant', tenant);
    await next();
  };
}

declare module 'hono' {
  interface ContextVariableMap {
    tenant: Tenant;
  }
}

export function tenantOf(c: Context): Tenant {
  const tenant = c.get('tenant');
  if (!tenant) throw new Error('No tenant context: route is not behind tenantContext()');
  return tenant;
}

/** Query against the request tenant's shard; binds `{tenant:String}` (see clickhouse/scoped.ts). */
export function dataQuery<T>(c: Context, sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const tenant = tenantOf(c);
  return tenantQuery<T>(shardClient(tenant.shardId), tenant.id, sql, params);
}
