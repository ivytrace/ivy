import { BUCKET_SECONDS, pickBucket } from '../stats/buckets.js';
import { buildRollupSource } from '../stats/rollup-query.js';
import { throttleSource } from '../stats/throttles.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { isoFromMs, round } from '../utils/format.js';
import { badRequest } from '../utils/http-error.js';
import type { TimeRange } from '../utils/time-range.js';

const MAX_POINTS = 2000;

/** Invocations, errors and p95 per bucket, with empty buckets filled in. */
export async function timeseries(scope: DataScope, range: TimeRange, options: { function?: string; bucket?: string } = {}) {
  const bucket = options.bucket || pickBucket(range);
  const step = BUCKET_SECONDS[bucket];
  if (!step) throw badRequest(`Invalid bucket: ${bucket}`);
  const stepMs = step * 1000;
  const first = Math.floor(range.from / stepMs) * stepMs;
  if ((range.to - first) / stepMs > MAX_POINTS) throw badRequest('Too many buckets for this range');

  const source = buildRollupSource({
    scope: queryScope(scope),
    range,
    bucketSeconds: step,
    functionName: options.function || undefined,
    useRollup: step >= 3600,
  });
  const rows = await scopedDataQuery<{ bucket_ms: number; invocations: number; errors: number; quantiles: number[] }>(
    scope,
    `SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms,
       sum(invocations) AS invocations,
       sum(errors) AS errors,
       quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q) AS quantiles
     FROM (${source.sql})
     GROUP BY bucket
     ORDER BY bucket`,
    source.params,
  );

  const throttles = throttleSource({ scope: queryScope(scope), range, bucketSeconds: step, functionName: options.function || undefined });
  const throttleRows = await scopedDataQuery<{ bucket_ms: number; throttles: number }>(
    scope,
    `SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms, sum(throttles) AS throttles FROM (${throttles.sql}) GROUP BY bucket`,
    throttles.params,
  );
  const throttleCounts = new Map(throttleRows.map((row) => [row.bucket_ms, row.throttles]));

  const byBucket = new Map(rows.map((row) => [row.bucket_ms, row]));
  const items = [];
  for (let ts = first; ts < range.to; ts += stepMs) {
    const row = byBucket.get(ts);
    items.push({
      ts: isoFromMs(ts),
      invocations: row?.invocations ?? 0,
      errors: row?.errors ?? 0,
      p95_ms: row ? round(row.quantiles[1], 1) : 0,
      throttles: throttleCounts.get(ts) ?? 0,
    });
  }
  return items;
}
