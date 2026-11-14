import type { Context } from 'hono';
import { jsonBody } from '../../lib/aws/requests.js';
import { membershipOf, requireOwner } from '../../lib/tenancy/context.js';
import { presentWorkspace, updateWorkspace } from '../../lib/tenancy/workspaces.js';

/** `name` and `slug` are for owners; `default_project` for any member (like the rest of project management). */
export async function patchWorkspace(c: Context) {
  const { workspace, role } = membershipOf(c);
  const body = await jsonBody(c);
  if (body.name !== undefined || body.slug !== undefined) requireOwner(c);
  const next = await updateWorkspace(workspace, body);
  return c.json(presentWorkspace(next, role));
}
