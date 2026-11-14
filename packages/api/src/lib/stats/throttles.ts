import { projectFilter, type QueryScope } from '../clickhouse/scoped.js';
import type { TimeRange } from '../utils/time-range.js';

/**
 * Subquery over function_throttles (per function and minute, polled from CloudWatch) with columns
 * [project_id,] function, region, [bucket], throttles, first_ms, last_ms. FINAL: a re-polled minute replaces its row.
 */
export function throttleSource(opts: { scope: QueryScope; range: TimeRange; bucketSeconds?: number; functionName?: string; byProject?: boolean }) {
  const bucket = opts.bucketSeconds ? ', toStartOfInterval(minute, INTERVAL {bucket_seconds:UInt32} SECOND) AS bucket' : '';
  const project = opts.byProject ? 'project_id, ' : '';
  const sql = `
      SELECT ${project}function, region${bucket},
        sum(throttles) AS throttles,
        toUnixTimestamp(min(minute)) * 1000 AS first_ms,
        toUnixTimestamp(max(minute)) * 1000 AS last_ms
      FROM function_throttles FINAL
      WHERE tenant_id = {tenant:String} ${projectFilter(opts.scope, 'project_id')}
        AND minute >= toDateTime(intDiv({from:Int64}, 1000)) AND minute < toDateTime(intDiv({to:Int64}, 1000))
        AND throttles > 0
        ${opts.functionName ? 'AND function = {function:String}' : ''}
      GROUP BY ${project}function, region${bucket ? ', bucket' : ''}`;
  return {
    sql,
    params: { from: opts.range.from, to: opts.range.to, function: opts.functionName ?? '', bucket_seconds: opts.bucketSeconds ?? 60 },
  };
}

export const THROTTLED_ERROR_TYPE = 'Throttled';
export const THROTTLED_MESSAGE = 'Lambda rejected these invocations (concurrency limit); they never reached the function, so there is no trace.';
