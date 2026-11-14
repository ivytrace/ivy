import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readAuthConfig } from '../../lib/auth/config.js';
import { bearerToken } from '../../lib/auth/middleware.js';
import { authUser } from '../../lib/auth/user.js';
import { verifiedEmail } from '../../lib/auth/userinfo.js';
import { publicUrl } from '../../lib/aws/config.js';
import { jsonBody } from '../../lib/aws/requests.js';
import { membershipOf, requireOwner } from '../../lib/tenancy/context.js';
import { acceptInvitation, createInvitation, presentInvitation } from '../../lib/tenancy/invitations.js';
import { requireMultiWorkspace } from '../../lib/tenancy/members.js';
import { presentWorkspace } from '../../lib/tenancy/workspaces.js';

/** The origin invite links point at: IVY_PUBLIC_URL, else the dashboard's origin from the request. */
function appOrigin(c: Context): string {
  const configured = publicUrl();
  if (configured) return configured;
  const origin = c.req.header('origin');
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return new URL(c.req.url).origin;
}

/** Owners invite by email: `{ "email": "…", "role"?: "member" | "owner" }`. The link is in the response once. */
export async function postInvitation(c: Context) {
  requireMultiWorkspace('Invitations');
  requireOwner(c);
  const created = await createInvitation(membershipOf(c).workspace, authUser(c), await jsonBody(c), appOrigin(c));
  return c.json(
    { invitation: presentInvitation(created.invitation), url: created.url, email_sent: created.emailSent, email_error: created.emailError },
    201,
  );
}

/** Accepts an invite link for the signed-in user (email must match and be verified). */
export async function postAcceptInvitation(c: Context) {
  const user = authUser(c);
  if (!readAuthConfig() || !user) throw new HTTPException(403, { message: 'Invitations need sign-in (OIDC), which is off on this server' });
  const email = await verifiedEmail(user, bearerToken(c.req.header('authorization')));
  const { workspace, role } = await acceptInvitation(c.req.param('token') ?? '', user, email);
  return c.json({ accepted: true, workspace: presentWorkspace(workspace, role) });
}
