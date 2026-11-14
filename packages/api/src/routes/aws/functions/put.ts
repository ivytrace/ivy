import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { presentFunction } from '../../../lib/aws/present.js';
import { isRegion } from '../../../lib/aws/regions.js';
import { jsonBody } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';
import { syncFunction } from '../../../lib/aws/sync.js';
import type { FunctionSetting } from '../../../lib/aws/types.js';
import { tenantOf } from '../../../lib/tenancy/context.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/**
 * Opts a function out of (or back into) tracing. The setting is stored first, so even if applying
 * it fails now, the next sync converges.
 */
export async function putAwsFunction(c: Context) {
  const tenant = tenantOf(c).id;
  const { accountId, region, name } = c.req.param() as { accountId: string; region: string; name: string };
  if (!isRegion(region)) throw badRequest(`Invalid region: ${region}`);
  const body = await jsonBody(c);
  if (typeof body.tracing_enabled !== 'boolean') throw badRequest('tracing_enabled must be a boolean');

  const account = (await awsStore().listAccounts(tenant)).find((a) => a.account_id === accountId);
  if (!account) throw new HTTPException(404, { message: 'Account not found' });

  const setting: FunctionSetting = { account_id: accountId, region, function_name: name, tracing_enabled: body.tracing_enabled };
  await awsStore().saveSetting(tenant, setting);
  const settings = new Map([[`${accountId}/${region}/${name}`, setting]]);

  if (account.status === 'pending') return c.json({ applied: false, error: 'Account not verified yet', function: null });
  try {
    const row = await syncFunction(account, region, name, body.tracing_enabled);
    return c.json({ applied: row.state !== 'error', error: row.state === 'error' ? row.reason : null, function: presentFunction(row, settings) });
  } catch (err) {
    return c.json({ applied: false, error: (err as Error).message, function: null });
  }
}
