import type { Context } from 'hono';
import { membershipOf, requireOwner } from '../../lib/tenancy/context.js';
import { requireMultiWorkspace } from '../../lib/tenancy/members.js';
import { deleteWorkspace } from '../../lib/tenancy/workspaces.js';

/** `DELETE /api/w/:workspace?confirm=<slug>`: owners only, and the slug must be repeated. */
export async function deleteWorkspaceRoute(c: Context) {
  requireMultiWorkspace('Deleting workspaces');
  requireOwner(c);
  await deleteWorkspace(membershipOf(c).workspace, c.req.query('confirm'));
  return c.json({ deleted: true });
}
