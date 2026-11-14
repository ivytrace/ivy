import type { Context } from 'hono';
import { publicUrl } from '../../lib/aws/config.js';
import { authUser } from '../../lib/auth/user.js';
import { digestCron, digestEnabled, digestMissing } from '../../lib/alerts/config.js';
import { buildDigest, digestPeriod, digestRecipients, isEmptyDigest, renderDigest } from '../../lib/alerts/digest.js';
import { digestSubscribed } from '../../lib/alerts/prefs.js';
import { alertStore } from '../../lib/alerts/store.js';
import { membershipOf } from '../../lib/tenancy/context.js';

/** The workspace's digest switch, the schedule, and whether the caller gets it. */
export async function getDigest(c: Context) {
  const { workspace, role } = membershipOf(c);
  const user = authUser(c);
  return c.json({
    available: digestEnabled(),
    missing: digestMissing(),
    schedule: digestCron(),
    enabled: await alertStore().getDigestEnabled(workspace.id),
    can_edit: role === 'owner',
    subscribed: user ? await digestSubscribed(workspace.id, user.sub) : null,
    recipients: (await digestRecipients(workspace.id)).length,
  });
}

/** The digest of the seven days up to and including today, as it would be sent (HTML and text). Needs no SMTP. */
export async function getDigestPreview(c: Context) {
  const { workspace } = membershipOf(c);
  const period = digestPeriod(Date.now() + 86_400_000);
  const model = await buildDigest(workspace, period);
  const baseUrl = publicUrl() ?? new URL(c.req.url).origin;
  const rendered = renderDigest(model, { baseUrl, unsubscribeUrl: `${baseUrl}/api/digest/unsubscribe?token=preview` });
  return c.json({
    ...rendered,
    period: { from: new Date(period.from).toISOString(), to: new Date(period.to).toISOString() },
    empty: isEmptyDigest(model),
  });
}
