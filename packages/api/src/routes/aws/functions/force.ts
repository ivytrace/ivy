import type { Context } from 'hono';
import { isRegion } from '../../../lib/aws/regions.js';
import { connectedAccount, currentSetting, jsonBody, saveAndApply } from '../../../lib/aws/requests.js';
import { tenantOf } from '../../../lib/tenancy/context.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/**
 * Force install over another tracer's exec wrapper (`force: true`, which also retries after the other tracer
 * set its wrapper back), or hand the wrapper back (`force: false`). Stored with the manual choice, so syncs
 * keep it; tags, manual choices and rules still decide whether the function is traced at all.
 */
export async function postAwsFunctionForce(c: Context) {
  const tenant = tenantOf(c).id;
  const { accountId, region, name } = c.req.param() as { accountId: string; region: string; name: string };
  if (!isRegion(region)) throw badRequest(`Invalid region: ${region}`);
  const { force } = await jsonBody(c);
  if (typeof force !== 'boolean') throw badRequest('force must be true or false');
  const account = await connectedAccount(tenant, accountId);
  const current = await currentSetting(tenant, accountId, region, name);
  const setting = { account_id: accountId, region, function_name: name, mode: current?.mode ?? '', project_id: current?.project_id ?? '', force };
  return c.json(await saveAndApply(tenant, account, setting, { retryForce: force }));
}
