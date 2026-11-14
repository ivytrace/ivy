import type { Workspace } from '@ivy/mcp';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readAuthConfig } from '../auth/config.js';
import { authUser } from '../auth/user.js';
import type { Tenant, TenantResolver } from '../tenancy/context.js';
import { singleTenantMode, tenantIdForUser } from '../tenancy/members.js';
import { tenancyStore } from '../tenancy/store.js';
import { DEFAULT_TENANT } from '../tenancy/tenants.js';

/** A workspace of the caller plus the tenant (and shard) its reads go to. */
export interface ApiWorkspace extends Workspace {
  tenant: Tenant;
}

/** Workspaces of one request; `options.tenants` (tests, custom setups) pins them to the one it resolves. */
export type WorkspaceSource = (c: Context) => Promise<ApiWorkspace[]>;

export const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Slugs from names, made unique among the caller's workspaces with a short ID suffix. */
export function withSlugs(records: { id: string; name: string; tenant: Tenant }[]): ApiWorkspace[] {
  const base = records.map((r) => slugify(r.name) || r.id.toLowerCase());
  return records.map((r, i) => {
    const clash = base.filter((b) => b === base[i]).length > 1;
    return { id: r.id, name: r.name, slug: clash ? `${base[i]}-${r.id.slice(-4).toLowerCase()}` : base[i], tenant: r.tenant };
  });
}

async function load(ids: string[]): Promise<ApiWorkspace[]> {
  const store = tenancyStore();
  const records = await Promise.all(ids.map((id) => store.getTenant(id)));
  return withSlugs(
    records
      .filter((r) => r !== null)
      .map((r) => ({ id: r.id, name: r.name, tenant: { id: r.id, shardId: r.shard_id } })),
  );
}

/**
 * The caller's workspaces: `default` with auth off or in single-tenant mode; otherwise every tenant
 * the signed-in user is a member of (their own is created on first use, as for /api).
 */
export function memberWorkspaces(): WorkspaceSource {
  return async (c) => {
    if (!readAuthConfig() || singleTenantMode()) return load([DEFAULT_TENANT]);
    const user = authUser(c);
    if (!user) throw new HTTPException(401, { message: 'Unauthorized' });
    await tenantIdForUser(user);
    const memberships = await tenancyStore().findMemberships(user.sub);
    return load([...new Set(memberships.map((m) => m.tenant_id))]);
  };
}

/** One workspace: the tenant a fixed resolver returns (used by tests and single-tenant embeddings). */
export function resolverWorkspaces(resolver: TenantResolver): WorkspaceSource {
  return async (c) => {
    const tenant = await resolver.resolve(c);
    if (!tenant) throw new HTTPException(401, { message: 'Unauthorized' });
    const [record] = await load([tenant.id]).catch(() => []);
    return withSlugs([{ id: tenant.id, name: record?.name ?? tenant.id, tenant }]);
  };
}
