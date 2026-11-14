import { shardClient } from '../clickhouse/client.js';
import { crossTenantQuery, tenantQuery } from '../clickhouse/scoped.js';
import { shardConfigs } from '../tenancy/shards.js';
import { splitOnHours, type TimeRange } from '../utils/time-range.js';

/** A calendar month in UTC, `YYYY-MM`. */
export type Month = string;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const monthOf = (ms: number): Month => new Date(ms).toISOString().slice(0, 7);

export function isMonth(value: string): boolean {
  return MONTH.test(value);
}

/** [first ms of the month, first ms of the next month). */
export function monthBounds(month: Month): { start: number; end: number } {
  const m = MONTH.exec(month);
  if (!m) throw new Error(`Invalid month ${month}`);
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return { start: Date.UTC(year, index, 1), end: Date.UTC(year, index + 1, 1) };
}

/** The part of the month that has happened by `now` (the whole month once it is over). */
export function monthRange(month: Month, now = Date.now()): TimeRange {
  const { start, end } = monthBounds(month);
  return { from: start, to: Math.max(start, Math.min(end, now)) };
}

/**
 * Traces (rows of `invocations`) in a range: whole hours from `invocations_hourly`, the partial
 * hours at the edges from `invocations`, like the data routes. Grouped by tenant when `perTenant`.
 */
function countSql(range: TimeRange, perTenant: boolean): { sql: string; params: Record<string, unknown> } {
  const { h1, h2 } = splitOnHours(range);
  const tenantFilter = (column: string) => (perTenant ? '1' : `${column} = {tenant:String}`);
  const select = perTenant ? 'tenant_id, ' : '';
  const group = perTenant ? 'GROUP BY tenant_id' : '';
  const sql = `
    SELECT ${select}sum(n) AS traces FROM (
      SELECT tenant_id, sum(invocations) AS n FROM invocations_hourly
      WHERE ${tenantFilter('tenant_id')}
        AND hour >= fromUnixTimestamp64Milli({h1:Int64}) AND hour < fromUnixTimestamp64Milli({h2:Int64})
      GROUP BY tenant_id
      UNION ALL
      SELECT tenant_id, count() AS n FROM invocations
      WHERE ${tenantFilter('tenant_id')}
        AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
        AND (ts < fromUnixTimestamp64Milli({h1:Int64}) OR ts >= fromUnixTimestamp64Milli({h2:Int64}))
      GROUP BY tenant_id
    ) ${group}`;
  return { sql, params: { from: range.from, to: range.to, h1, h2 } };
}

/** Exact trace count of one tenant in a month, up to `now`. */
export async function countMonthlyTraces(tenant: { id: string; shardId: string }, month: Month, now = Date.now()): Promise<number> {
  const range = monthRange(month, now);
  if (range.from >= range.to) return 0;
  const { sql, params } = countSql(range, false);
  const rows = await tenantQuery<{ traces: number }>(shardClient(tenant.shardId), tenant.id, sql, params);
  return Number(rows[0]?.traces ?? 0);
}

/** Trace counts of every tenant with traces in the month, across all shards. */
export async function countMonthlyTracesAllTenants(month: Month, now = Date.now()): Promise<Map<string, number>> {
  const range = monthRange(month, now);
  const out = new Map<string, number>();
  if (range.from >= range.to) return out;
  const { sql, params } = countSql(range, true);
  for (const shardId of shardConfigs().keys()) {
    // Cross-tenant by nature: the metering list for billing.
    const rows = await crossTenantQuery<{ tenant_id: string; traces: number }>(shardClient(shardId), sql, params);
    for (const row of rows) out.set(row.tenant_id, (out.get(row.tenant_id) ?? 0) + Number(row.traces));
  }
  return out;
}

const TTL_MS = 60_000;
const cache = new Map<string, { value: number; expires: number }>();
const pending = new Map<string, Promise<number>>();

/** This month's traces of a tenant, cached for a minute (the dashboard's usage view). */
export async function currentMonthTraces(tenant: { id: string; shardId: string }, now = Date.now()): Promise<number> {
  const month = monthOf(now);
  const key = `${tenant.id}/${month}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  let lookup = pending.get(key);
  if (!lookup) {
    lookup = countMonthlyTraces(tenant, month, now).finally(() => pending.delete(key));
    pending.set(key, lookup);
  }
  const value = await lookup;
  cache.set(key, { value, expires: now + TTL_MS });
  return value;
}

export function clearUsageCacheForTests() {
  cache.clear();
  pending.clear();
}
