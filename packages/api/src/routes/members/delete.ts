import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { removeMember, requireMultiWorkspace } from '../../lib/tenancy/members.js';

/** Owners remove anyone; members can only remove themselves (leave). The last owner can't leave. */
export async function deleteMember(c: Context) {
  requireMultiWorkspace('Workspace members');
  const sub = c.req.param('sub') ?? '';
  if (sub !== authUser(c)?.sub) requireOwner(c);
  await removeMember(tenantOf(c).id, sub);
  return c.json({ removed: true });
}
