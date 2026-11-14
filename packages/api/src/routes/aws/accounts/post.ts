import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalArn, roleArnFor } from '../../../lib/aws/clients.js';
import { defaultRegion } from '../../../lib/aws/config.js';
import { presentAccount } from '../../../lib/aws/present.js';
import { isRegion } from '../../../lib/aws/regions.js';
import { jsonBody, parseRegions } from '../../../lib/aws/requests.js';
import { awsStore } from '../../../lib/aws/store.js';
import type { AwsAccount } from '../../../lib/aws/types.js';
import { tenantOf } from '../../../lib/tenancy/context.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/** Creates a pending connection. The user then deploys the stack and calls verify. */
export async function postAwsAccount(c: Context) {
  const tenant = tenantOf(c).id;
  const body = await jsonBody(c);
  const accountId = String(body.account_id ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(accountId)) throw badRequest('account_id must be a 12-digit AWS account ID');
  const allRegions = body.all_regions === true;
  const regions = body.regions === undefined ? [] : parseRegions(body.regions);
  const stackRegion = typeof body.stack_region === 'string' && body.stack_region ? body.stack_region : (regions[0] ?? defaultRegion());
  if (!isRegion(stackRegion)) throw badRequest(`Invalid stack_region: ${stackRegion}`);
  if (!allRegions && !regions.includes(stackRegion)) regions.unshift(stackRegion);

  const existing = await awsStore().listAccounts(tenant);
  if (existing.some((a) => a.account_id === accountId)) {
    throw new HTTPException(409, { message: `AWS account ${accountId} is already connected` });
  }

  const id = randomUUID();
  const short = id.replaceAll('-', '').slice(0, 8);
  const account: AwsAccount = {
    tenant_id: tenant,
    id,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : `AWS ${accountId}`,
    account_id: accountId,
    role_arn: roleArnFor(accountId, `IvyTrace-${short}`),
    external_id: `ivy-${randomBytes(16).toString('hex')}`,
    event_secret: randomBytes(24).toString('base64url'),
    stack_name: `ivy-trace-${short}`,
    stack_region: stackRegion,
    regions,
    all_regions: allRegions,
    status: 'pending',
    error: '',
    created_at: Date.now(),
    verified_at: 0,
    last_sync_at: 0,
  };
  await awsStore().saveAccount(account);
  return c.json(presentAccount(account, await principalArn()), 201);
}
