import { splitOnHours, type TimeRange } from '../utils/time-range.js';

export interface RollupSourceOptions {
  range: TimeRange;
  /** Bucket width in seconds; adds a `bucket` column when set. */
  bucketSeconds?: number;
  functionName?: string;
  useRollup: boolean;
}

/**
 * Subquery with columns: function, region, [bucket], invocations, errors, cold_starts,
 * duration_sum, last_invoked, duration_q (quantilesTDigest(0.5, 0.95, 0.99) state).
 * Whole hours are read from invocations_hourly, the partial hours at the edges from invocations.
 */
export function buildRollupSource(opts: RollupSourceOptions): { sql: string; params: Record<string, unknown> } {
  const { h1, h2 } = opts.useRollup ? splitOnHours(opts.range) : { h1: opts.range.to, h2: opts.range.to };
  const bucketCol = (column: string) =>
    opts.bucketSeconds
      ? `, toStartOfInterval(toDateTime(${column}), INTERVAL {bucket_seconds:UInt32} SECOND) AS bucket`
      : '';
  const fnFilter = opts.functionName ? 'AND function = {function:String}' : '';
  const keys = opts.bucketSeconds ? 'function, region, bucket' : 'function, region';

  const sql = `
      SELECT function, region${bucketCol('hour')},
        sum(invocations) AS invocations,
        sum(errors) AS errors,
        sum(cold_starts) AS cold_starts,
        sum(duration_sum) AS duration_sum,
        max(last_invoked) AS last_invoked,
        quantilesTDigestMergeState(0.5, 0.95, 0.99)(duration_q) AS duration_q
      FROM invocations_hourly
      WHERE tenant_id = {tenant:String}
        AND hour >= fromUnixTimestamp64Milli({h1:Int64}) AND hour < fromUnixTimestamp64Milli({h2:Int64})
        ${fnFilter}
      GROUP BY ${keys}
      UNION ALL
      SELECT function, region${bucketCol('ts')},
        count() AS invocations,
        countIf(status = 'error') AS errors,
        countIf(cold_start) AS cold_starts,
        sum(duration_ms) AS duration_sum,
        max(ts) AS last_invoked,
        quantilesTDigestState(0.5, 0.95, 0.99)(duration_ms) AS duration_q
      FROM invocations
      WHERE tenant_id = {tenant:String}
        AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
        AND (ts < fromUnixTimestamp64Milli({h1:Int64}) OR ts >= fromUnixTimestamp64Milli({h2:Int64}))
        ${fnFilter}
      GROUP BY ${keys}`;

  return {
    sql,
    params: {
      from: opts.range.from,
      to: opts.range.to,
      h1,
      h2,
      ...(opts.bucketSeconds ? { bucket_seconds: opts.bucketSeconds } : {}),
      ...(opts.functionName ? { function: opts.functionName } : {}),
    },
  };
}
