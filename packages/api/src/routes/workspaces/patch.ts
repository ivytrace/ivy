import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { membershipOf, requireOwner } from '../../lib/tenancy/context.js';
import { presentWorkspace, updateWorkspace } from '../../lib/tenancy/workspaces.js';

/** `name` and `slug`, for owners. */
export async function patchWorkspace(c: Context) {
  const { workspace, role } = membershipOf(c);
  const body = await jsonBody(c);
  requireOwner(c);
  const next = await updateWorkspace(workspace, body);
  return c.json(presentWorkspace(next, role));
}
