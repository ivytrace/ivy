import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { jsonBody } from '../../lib/aws/requests.js';
import { authUser } from '../../lib/auth/user.js';
import { digestEnabled } from '../../lib/alerts/config.js';
import { setDigestSubscription } from '../../lib/alerts/prefs.js';
import { alertStore } from '../../lib/alerts/store.js';
import type { WorkspaceAccess } from '../../lib/tenancy/context.js';
import { badRequest } from '../../lib/utils/http-error.js';

function signedIn(c: Context) {
  const user = authUser(c);
  if (!user) throw new HTTPException(403, { message: 'Notifications are per user and need sign-in (OIDC), which is off on this server' });
  return user;
}

/** The caller's digest subscription per workspace (default: subscribed). */
export const getNotifications = (access: WorkspaceAccess) => async (c: Context) => {
  const user = signedIn(c);
  const items = [];
  for (const { workspace } of await access.list(c)) {
    const pref = (await alertStore().listPrefs(workspace.id)).find((p) => p.sub === user.sub);
    items.push({ workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name }, digest: pref?.digest ?? true });
  }
  return c.json({ email: user.email ?? null, digest_available: digestEnabled(), items });
};

/** Members change their own digest subscription: `{ "workspace": slug or ID, "digest": bool }`. */
export const putNotifications = (access: WorkspaceAccess) => async (c: Context) => {
  const user = signedIn(c);
  const body = await jsonBody(c);
  if (typeof body.digest !== 'boolean') throw badRequest('digest must be a boolean');
  const membership = typeof body.workspace === 'string' ? await access.find(c, body.workspace) : null;
  if (!membership) throw new HTTPException(404, { message: 'Workspace not found' });
  await setDigestSubscription(membership.workspace.id, user.sub, user.email ?? '', body.digest);
  return c.json({ workspace: { id: membership.workspace.id, slug: membership.workspace.slug, name: membership.workspace.name }, digest: body.digest });
};
