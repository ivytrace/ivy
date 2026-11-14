import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { jsonBody } from '../../lib/aws/requests.js';
import { requireMultiWorkspace } from '../../lib/tenancy/members.js';
import { createWorkspace, presentWorkspace } from '../../lib/tenancy/workspaces.js';

export async function postWorkspace(c: Context) {
  requireMultiWorkspace('Creating workspaces');
  const user = authUser(c)!;
  const workspace = await createWorkspace(user, await jsonBody(c));
  return c.json(presentWorkspace(workspace, 'owner'), 201);
}
