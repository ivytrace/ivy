import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { jsonBody } from '../../lib/aws/requests.js';
import { requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { presentMember, requireMultiWorkspace, setMemberRole } from '../../lib/tenancy/members.js';

/** Owners change roles (`{ "role": "owner" | "member" }`); the last owner can't be demoted. */
export async function patchMember(c: Context) {
  requireMultiWorkspace('Workspace members');
  requireOwner(c);
  const member = await setMemberRole(tenantOf(c).id, c.req.param('sub') ?? '', (await jsonBody(c)).role);
  return c.json(presentMember(member, authUser(c)?.sub ?? null));
}
