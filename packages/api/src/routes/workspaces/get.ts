import type { Context } from 'hono';
import { membershipOf, type WorkspaceAccess } from '../../lib/tenancy/context.js';
import { presentWorkspace } from '../../lib/tenancy/workspaces.js';

/** The caller's workspaces (a user without any gets a personal one, see members.ts). */
export const getWorkspaces = (access: WorkspaceAccess) => async (c: Context) => {
  const memberships = await access.list(c);
  return c.json({ items: memberships.map((m) => presentWorkspace(m.workspace, m.role)) });
};

export function getWorkspace(c: Context) {
  const { workspace, role } = membershipOf(c);
  return c.json(presentWorkspace(workspace, role));
}
