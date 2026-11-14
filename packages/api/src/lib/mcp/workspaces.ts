import type { Workspace } from '@ivy/mcp';
import type { Context } from 'hono';
import { lookupTenant, type Tenant, type WorkspaceAccess } from '../tenancy/context.js';

/** A workspace of the caller plus the tenant (and shard) its reads go to. */
export interface ApiWorkspace extends Workspace {
  tenant: Tenant;
}

/** Workspaces of one request. */
export type WorkspaceSource = (c: Context) => Promise<ApiWorkspace[]>;

/**
 * The caller's workspaces, exactly as the API sees them (`WorkspaceAccess.list`): `default` with auth
 * off or in single-tenant mode, otherwise every workspace the signed-in user is a member of (their
 * personal one is created on first use). Slugs are the workspaces' own.
 */
export function accessWorkspaces(access: WorkspaceAccess): WorkspaceSource {
  return async (c) => {
    const memberships = await access.list(c);
    const out: ApiWorkspace[] = [];
    for (const { workspace } of memberships) {
      const tenant = await lookupTenant(workspace.id);
      if (tenant) out.push({ id: workspace.id, name: workspace.name, slug: workspace.slug, tenant });
    }
    return out;
  };
}
