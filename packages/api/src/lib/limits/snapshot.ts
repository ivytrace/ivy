import { effectiveLimits } from './limits.js';
import type { QuotaSnapshot } from './quota-gate.js';
import { limitsStore } from './store.js';
import { countMonthlyTraces, type Month } from './usage.js';

/** The router's view of a tenant: its limits, and this month's traces only when the limits can block. */
export async function loadQuotaSnapshot(tenantId: string, shardId: string, month: Month): Promise<QuotaSnapshot> {
  const limits = effectiveLimits(await limitsStore().get(tenantId));
  const canBlock = limits.over_quota === 'block' && limits.monthly_trace_quota !== null;
  return { limits, used: canBlock ? await countMonthlyTraces({ id: tenantId, shardId }, month) : 0 };
}

/** Where the 429 message sends people: IVY_UPGRADE_URL, else the dashboard's usage settings. */
export function upgradeUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.IVY_UPGRADE_URL?.trim();
  if (explicit) return explicit;
  const publicUrl = env.IVY_PUBLIC_URL?.trim().replace(/\/$/, '');
  return publicUrl ? `${publicUrl}/settings/usage` : undefined;
}
