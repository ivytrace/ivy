import { tenancyStore } from '../tenancy/store.js';
import { effectiveLimits } from './limits.js';
import type { QuotaSnapshot } from './quota-gate.js';
import { limitsStore } from './store.js';
import { countMonthlyTraces, type Month } from './usage.js';

/**
 * The router's view of a tenant: its limits, and (only when the limits can block) this month's traces across all
 * its projects and the link to its usage page.
 */
export async function loadQuotaSnapshot(tenantId: string, shardId: string, month: Month): Promise<QuotaSnapshot> {
  const limits = effectiveLimits(await limitsStore().get(tenantId));
  const canBlock = limits.over_quota === 'block' && limits.monthly_trace_quota !== null;
  if (!canBlock) return { limits, used: 0 };
  const [used, tenant] = await Promise.all([countMonthlyTraces({ id: tenantId, shardId }, month), tenancyStore().getTenant(tenantId)]);
  return { limits, used, upgradeUrl: upgradeUrl(tenant?.slug || tenantId) };
}

/**
 * Where the 429 message sends people: IVY_UPGRADE_URL (`{workspace}` is replaced by the workspace's slug), else
 * the workspace's usage page in the dashboard (`IVY_PUBLIC_URL/w/<slug>/settings/usage`).
 */
export function upgradeUrl(workspace: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.IVY_UPGRADE_URL?.trim();
  if (explicit) return explicit.replaceAll('{workspace}', encodeURIComponent(workspace));
  const publicUrl = env.IVY_PUBLIC_URL?.trim().replace(/\/$/, '');
  return publicUrl ? `${publicUrl}/w/${encodeURIComponent(workspace)}/settings/usage` : undefined;
}
