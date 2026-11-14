import type { Context } from 'hono';
import { loadAccount, presentAccounts } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';
import { tenantOf } from '../../../lib/tenancy/context.js';

export async function getAwsAccounts(c: Context) {
  return c.json({ items: await presentAccounts(c, await awsStore().listAccounts(tenantOf(c).id)) });
}

export async function getAwsAccount(c: Context) {
  const [account] = await presentAccounts(c, [await loadAccount(c)]);
  return c.json(account);
}
