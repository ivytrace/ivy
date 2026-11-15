import type { Context } from 'hono';
import { jsonBody, loadAccount, parseRegions, presentAccounts } from '../../../lib/aws/requests.js';
import { triggerSync } from '../../../lib/aws/scheduler.js';
import { awsStore } from '../../../lib/aws/store.js';
import { badRequest } from '../../../lib/utils/http-error.js';

/**
 * Changes the name, the regions to scan, the throttle polling setting, or marks the
 * function list as reviewed. A connected account is synced right away when its regions change.
 */
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
  if (body.throttle_metrics !== undefined) {
    if (typeof body.throttle_metrics !== 'boolean') throw badRequest('throttle_metrics must be a boolean');
    next.throttle_metrics = body.throttle_metrics;
  }
  if (!next.all_regions && !next.regions.length) throw badRequest('Pick at least one region, or all_regions');
  if (body.reviewed === true) next.reviewed_at = Date.now();

  await awsStore().saveAccount(next);
  const regionsChanged = next.all_regions !== account.all_regions || next.regions.join() !== account.regions.join();
  if (next.status !== 'pending' && regionsChanged) void triggerSync(next);
  const [presented] = await presentAccounts(c, [next]);
  return c.json(presented);
}
