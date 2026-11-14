import type { Context } from 'hono';
import { detachAccount } from '../../../lib/aws/sync.js';
import { forgetCredentials } from '../../../lib/aws/clients.js';
import { loadAccount } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';

/**
 * Disconnects an account. Unless `detach=false`, the layer and Ivy's variables are removed from
 * its functions first (best effort: the role may already be gone). The stack itself is the
 * user's to delete.
 */
export async function deleteAwsAccount(c: Context) {
  const account = await loadAccount(c);
  const detach = c.req.query('detach') !== 'false' && account.status !== 'pending';
  const detachErrors = detach ? await detachAccount(account).catch((err: Error) => [err.message]) : [];
  forgetCredentials(account);
  await awsStore().deleteAccountFunctions(account.tenant_id, account.account_id);
  await awsStore().deleteAccount(account);
  return c.json({ deleted: true, detached: detach, detach_errors: detachErrors });
}
