import type { Context } from 'hono';
import { EVENT_SECRET_HEADER } from '../../lib/aws/config.js';
import { triggerSync } from '../../lib/aws/scheduler.js';
import { awsStore } from '../../lib/aws/store.js';

interface LambdaApiEvent {
  account?: string;
  region?: string;
}

/**
 * EventBridge API destination target (optional, see the template). Authenticated by the
 * per-connection secret, not by user auth. Triggers a sync of the event's region.
 */
export async function postAwsEvent(c: Context) {
  const account = await awsStore().findAccountByEventSecret(c.req.header(EVENT_SECRET_HEADER) ?? '');
  if (!account) return c.json({ error: 'Unauthorized' }, 401);
  const event = (await c.req.json().catch(() => ({}))) as LambdaApiEvent;
  if (event.account && event.account !== account.account_id) return c.json({ error: 'Account mismatch' }, 403);
  if (account.status !== 'pending') void triggerSync(account, event.region ? [event.region] : undefined);
  return c.json({ accepted: true }, 202);
}
