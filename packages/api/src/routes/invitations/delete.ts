import type { Context } from 'hono';
import { requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { presentInvitation, revokeInvitation } from '../../lib/tenancy/invitations.js';
import { requireMultiWorkspace } from '../../lib/tenancy/members.js';

export async function deleteInvitation(c: Context) {
  requireMultiWorkspace('Invitations');
  requireOwner(c);
  return c.json(presentInvitation(await revokeInvitation(tenantOf(c).id, c.req.param('id') ?? '')));
}
