import { badRequest } from '../utils/http-error.js';
import { effectiveLimits, overQuota, type EffectiveLimits } from './limits.js';
import { limitsStore } from './store.js';
import { countMonthlyTraces, currentMonthTraces, isMonth, monthBounds, monthOf, type Month } from './usage.js';

export interface WorkspaceUsage {
  workspace: string;
  month: Month;
  period: { start: string; end: string };
  traces: number;
  limits: EffectiveLimits;
  /** Ingest is being refused (quota reached with `block`). */
  blocked: boolean;
}

export function parseMonth(value: string | undefined, now = Date.now()): Month {
  if (value === undefined || value === '') return monthOf(now);
  if (!isMonth(value)) throw badRequest(`Invalid month: ${value} (use YYYY-MM)`);
  return value;
}

export function usageBody(workspace: string, month: Month, traces: number, limits: EffectiveLimits): WorkspaceUsage {
  const { start, end } = monthBounds(month);
  return {
    workspace,
    month,
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    traces,
    limits,
    blocked: overQuota(limits, traces),
  };
}

/**
 * A workspace's traces in a month with its limits. `cached`: this month's count may be up to a minute
 * old (the dashboard); the internal API always counts.
 */
export async function workspaceUsage(
  tenant: { id: string; shardId: string },
  month: Month,
  { now = Date.now(), cached = false }: { now?: number; cached?: boolean } = {},
): Promise<WorkspaceUsage> {
  const [row, traces] = await Promise.all([
    limitsStore().get(tenant.id),
    cached && month === monthOf(now) ? currentMonthTraces(tenant, now) : countMonthlyTraces(tenant, month, now),
  ]);
  return usageBody(tenant.id, month, traces, effectiveLimits(row));
}
