import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readAuthConfig } from '../../lib/auth/config.js';
import { requireOwner, tenantOf } from '../../lib/tenancy/context.js';
import { invitationStatus, lookupInvitation, presentInvitation } from '../../lib/tenancy/invitations.js';
import { requireMultiWorkspace } from '../../lib/tenancy/members.js';
import { tenancyStore } from '../../lib/tenancy/store.js';

/** A workspace's invitations (owners only); `?all=1` includes accepted, revoked and expired ones. */
export async function getInvitations(c: Context) {
  requireMultiWorkspace('Invitations');
  requireOwner(c);
  const all = c.req.query('all') === '1';
  const items = (await tenancyStore().listInvitations(tenantOf(c).id)).filter((i) => all || invitationStatus(i) === 'pending');
  return c.json({ items: items.map(presentInvitation) });
}

/** What an invite link is for, so the accept page can show it. Needs a signed-in user. */
export async function getInvitationByToken(c: Context) {
  if (!readAuthConfig()) throw new HTTPException(403, { message: 'Invitations need sign-in (OIDC), which is off on this server' });
  const { invitation, workspace } = await lookupInvitation(c.req.param('token') ?? '');
  return c.json({
    workspace: { slug: workspace.slug, name: workspace.name },
    email: invitation.email,
    role: invitation.role,
    status: invitationStatus(invitation),
    invited_by: invitation.invited_by_email || null,
    expires_at: new Date(invitation.expires_at).toISOString(),
  });
}
