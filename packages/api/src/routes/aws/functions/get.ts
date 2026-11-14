import type { Context } from 'hono';
import { presentFunction } from '../../../lib/aws/present.js';
import { awsStore } from '../../../lib/aws/store.js';
import type { FunctionSetting } from '../../../lib/aws/types.js';
import { tenantOf } from '../../../lib/clickhouse/tenant.js';

/** Tracing state of every function in the connected accounts; `account` (12-digit ID) narrows it. */
export async function getAwsFunctions(c: Context) {
  const tenant = tenantOf(c);
  const accountId = c.req.query('account') || undefined;
  const store = awsStore();
  const [functions, accounts] = await Promise.all([store.listFunctions(tenant, accountId), store.listAccounts(tenant)]);
  const ids = accountId ? [accountId] : accounts.map((a) => a.account_id);
  const settings = new Map<string, FunctionSetting>();
  for (const list of await Promise.all(ids.map((id) => store.listSettings(tenant, id)))) {
    for (const s of list) settings.set(`${s.account_id}/${s.region}/${s.function_name}`, s);
  }
  return c.json({ items: functions.map((f) => presentFunction(f, settings)) });
}
