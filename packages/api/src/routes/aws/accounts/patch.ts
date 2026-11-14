import type { Context } from 'hono';
import { principalArn } from '../../../lib/aws/clients.js';
import { presentAccount } from '../../../lib/aws/present.js';
import { jsonBody, loadAccount, parseRegions } from '../../../lib/aws/requests.js';
import { triggerSync } from '../../../lib/aws/scheduler.js';
import { awsStore } from '../../../lib/aws/store.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/** Changes the name or the regions to scan. A connected account is synced right away. */
export async function patchAwsAccount(c: Context) {
  const account = await loadAccount(c);
  const body = await jsonBody(c);
  const next = { ...account };
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name must be a non-empty string');
    next.name = body.name.trim().slice(0, 100);
  }
  if (body.regions !== undefined) next.regions = parseRegions(body.regions);
  if (body.all_regions !== undefined) next.all_regions = body.all_regions === true;
  if (!next.all_regions && !next.regions.length) throw badRequest('Pick at least one region, or all_regions');

  await awsStore().saveAccount(next);
  if (next.status !== 'pending') void triggerSync(next);
  const counts = await awsStore().functionCounts(next.tenant_id);
  return c.json(presentAccount(next, await principalArn(), counts.get(next.account_id)));
}
