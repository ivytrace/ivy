import type { Context } from 'hono';
import { principalArn } from '../../../lib/aws/clients.js';
import { presentAccount } from '../../../lib/aws/present.js';
import { loadAccount } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';
import { tenantOf } from '../../../lib/clickhouse/tenant.js';

export async function getAwsAccounts(c: Context) {
  const tenant = tenantOf(c);
  const [accounts, counts, principal] = await Promise.all([
    awsStore().listAccounts(tenant),
    awsStore().functionCounts(tenant),
    principalArn(),
  ]);
  return c.json({ items: accounts.map((a) => presentAccount(a, principal, counts.get(a.account_id))) });
}

export async function getAwsAccount(c: Context) {
  const account = await loadAccount(c);
  const counts = await awsStore().functionCounts(account.tenant_id);
  return c.json(presentAccount(account, await principalArn(), counts.get(account.account_id)));
}
