import type { Context } from 'hono';
import { EVENT_SECRET_HEADER } from '../../lib/aws/config.js';
import { triggerFunctionSync, triggerSync } from '../../lib/aws/scheduler.js';
import { awsStore } from '../../lib/aws/store.js';
import { accountRegions } from '../../lib/aws/sync.js';
import type { AwsAccount } from '../../lib/aws/types.js';

/** The parts of an "AWS API Call via CloudTrail" event Ivy reads. */
interface CloudTrailEvent {
  account?: string;
  region?: string;
  detail?: {
    errorCode?: string;
    userIdentity?: { sessionContext?: { sessionIssuer?: { arn?: string } } };
    requestParameters?: { functionName?: string } | null;
    responseElements?: { functionName?: string } | null;
  };
}

/** `FunctionName` may be a name, an ARN or a partial ARN (`<account>:function:<name>`). */
const functionNameOf = (id: string) => /(?:^|:)function:([^:]+)/.exec(id)?.[1] ?? id;

function ignoreReason(account: AwsAccount, event: CloudTrailEvent): string | null {
  if (account.status === 'pending') return 'account not connected yet';
  if (event.detail?.errorCode) return 'failed call';
  if (event.detail?.userIdentity?.sessionContext?.sessionIssuer?.arn === account.role_arn) return "Ivy's own call";
  if (event.region && !accountRegions(account).includes(event.region)) return 'region not synced';
  return null;
}

/**
 * EventBridge API destination target (optional, see the template). Authenticated by the
 * per-connection secret, not by user auth. Syncs the function the event names, else the event's region.
 */
export async function postAwsEvent(c: Context) {
  const account = await awsStore().findAccountByEventSecret(c.req.header(EVENT_SECRET_HEADER) ?? '');
  if (!account) return c.json({ error: 'Unauthorized' }, 401);
  const event = (await c.req.json().catch(() => ({}))) as CloudTrailEvent;
  if (event.account && event.account !== account.account_id) return c.json({ error: 'Account mismatch' }, 403);

  const ignored = ignoreReason(account, event);
  if (ignored) return c.json({ accepted: false, ignored }, 202);

  const fn = event.detail?.responseElements?.functionName ?? event.detail?.requestParameters?.functionName;
  if (event.region && fn) void triggerFunctionSync(account, event.region, functionNameOf(fn));
  else void triggerSync(account, event.region ? [event.region] : undefined);
  return c.json({ accepted: true }, 202);
}
