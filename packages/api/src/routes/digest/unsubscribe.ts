import type { Context } from 'hono';
import { readUnsubscribeToken } from '../../lib/alerts/digest.js';
import { escapeHtml, simplePage } from '../../lib/alerts/page.js';
import { setDigestSubscription } from '../../lib/alerts/prefs.js';
import { tenancyStore } from '../../lib/tenancy/store.js';

/**
 * The digest's unsubscribe link: works without signing in, from a signed token naming the workspace
 * and recipient. GET shows a confirmation button (so link scanners don't unsubscribe anyone); POST
 * unsubscribes, and is also what mail clients send for one-click List-Unsubscribe (RFC 8058).
 */
async function target(c: Context) {
  const token = c.req.query('token') ?? '';
  const parsed = readUnsubscribeToken(token);
  const workspace = parsed && (await tenancyStore().getTenant(parsed.tenant));
  return parsed && workspace ? { ...parsed, workspace, token } : null;
}

const invalid = (c: Context) =>
  c.html(simplePage('This link is not valid', 'The unsubscribe link is incomplete or was changed. You can also switch the digest off under Notifications in Ivy.'), 400);

export async function getUnsubscribe(c: Context) {
  const t = await target(c);
  if (!t) return invalid(c);
  const form = `<form method="post" action="/api/digest/unsubscribe?token=${encodeURIComponent(t.token)}"><button type="submit">Unsubscribe</button></form>`;
  return c.html(simplePage(`Unsubscribe from ${t.workspace.name}’s weekly digest?`, 'You will no longer get the weekly error digest of this workspace by email.', form));
}

export async function postUnsubscribe(c: Context) {
  const t = await target(c);
  if (!t) return invalid(c);
  await setDigestSubscription(t.tenant, t.sub, t.sub.startsWith('email:') ? t.sub.slice(6) : '', false);
  return c.html(
    simplePage(
      'You are unsubscribed',
      `You will no longer get the weekly digest of ${t.workspace.name}.`,
      `<p>Changed your mind? Switch it back on under Notifications in <a href="/w/${escapeHtml(encodeURIComponent(t.workspace.slug))}/settings/notifications">Ivy</a>.</p>`,
    ),
  );
}
