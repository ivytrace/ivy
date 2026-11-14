import type { Context } from 'hono';
import { listWorkspaceMembers } from '../../../lib/internal/members.js';
import { findWorkspace } from '../workspaces/get.js';

/** `GET /internal/workspaces/:id/members`: who belongs to the workspace, for billing's owner check. */
export async function getInternalMembers(c: Context) {
  const tenant = await findWorkspace(c);
  return c.json({ workspace: tenant.id, items: await listWorkspaceMembers(tenant.id) });
}
