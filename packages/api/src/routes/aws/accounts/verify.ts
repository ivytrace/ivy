import type { Context } from 'hono';
import { assumeRole } from '../../../lib/aws/clients.js';
import { loadAccount, presentAccounts } from '../../../lib/aws/requests.js';
import { triggerSync } from '../../../lib/aws/scheduler.js';
import { awsStore } from '../../../lib/aws/store.js';

/**
 * Tries to assume the role with the connection's external ID. The UI polls this after opening the
 * quick-create link; the first success marks the account connected and starts the first sync.
 */
export async function verifyAwsAccount(c: Context) {
  const account = await loadAccount(c);
  try {
    await assumeRole(account, true);
  } catch (err) {
    const reason = (err as Error).message;
    const failed = {
      ...account,
      status: account.status === 'pending' ? ('pending' as const) : ('error' as const),
      error: `Can't assume ${account.role_arn} yet: ${reason}`,
    };
    await awsStore().saveAccount(failed);
    return c.json({ verified: false, account: (await presentAccounts(c, [failed]))[0] });
  }

  const connected = { ...account, status: 'connected' as const, error: '', verified_at: account.verified_at || Date.now() };
  await awsStore().saveAccount(connected);
  void triggerSync(connected);
  return c.json({ verified: true, account: (await presentAccounts(c, [connected]))[0] });
}
