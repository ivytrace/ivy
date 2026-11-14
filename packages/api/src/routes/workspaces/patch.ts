import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { membershipOf, requireOwner } from '../../lib/tenancy/context.js';
import { presentWorkspace, updateWorkspace } from '../../lib/tenancy/workspaces.js';

export async function patchWorkspace(c: Context) {
  requireOwner(c);
  const { workspace, role } = membershipOf(c);
  const next = await updateWorkspace(workspace, await jsonBody(c));
  return c.json(presentWorkspace(next, role));
}
