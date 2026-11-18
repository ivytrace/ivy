import { projectFilter } from '../clickhouse/scoped.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import type { TimeRange } from '../utils/time-range.js';

const MAX_KEYS = 100;
/** The keys are read from at most this much of the range (its end), to bound the scan on long ranges. */
const MAX_WINDOW_MS = 24 * 3_600_000;
/** Bodies and header maps: searching them by exact value is no use. */
const UNSEARCHABLE = '^ivy\\.(payload|http)\\.';

/** Span attribute keys in use in the scope, most used first: what `key=value` search terms can name. */
export async function attributeKeys(scope: DataScope, range: TimeRange) {
  const rows = await scopedDataQuery<{ key: string; spans: number }>(
    scope,
    `SELECT arrayJoin(mapKeys(SpanAttributes)) AS key, count() AS spans
     FROM otel_traces
     WHERE TenantId = {tenant:String} ${projectFilter(queryScope(scope), 'ProjectId')}
       AND Timestamp >= fromUnixTimestamp64Milli({from:Int64})
       AND Timestamp < fromUnixTimestamp64Milli({to:Int64})
     GROUP BY key
     HAVING NOT match(key, {unsearchable:String})
     ORDER BY spans DESC, key
     LIMIT ${MAX_KEYS}`,
    { from: Math.max(range.from, range.to - MAX_WINDOW_MS), to: range.to, unsearchable: UNSEARCHABLE },
  );
  return rows.map((row) => ({ key: row.key, spans: Number(row.spans) }));
}
