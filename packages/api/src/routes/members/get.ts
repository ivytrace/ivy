import type { Context } from 'hono';
import { authUser } from '../../lib/auth/user.js';
import { tenantOf } from '../../lib/tenancy/context.js';
import { presentMember, requireMultiWorkspace } from '../../lib/tenancy/members.js';
import { tenancyStore } from '../../lib/tenancy/store.js';

export async function getMembers(c: Context) {
  requireMultiWorkspace('Workspace members');
  const me = authUser(c)?.sub ?? null;
  const members = await tenancyStore().listMembers(tenantOf(c).id);
  return c.json({ items: members.map((m) => presentMember(m, me)) });
}
