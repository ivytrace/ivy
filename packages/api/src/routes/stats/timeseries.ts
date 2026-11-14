import type { Context } from 'hono';
import { dataQuery } from '../../lib/tenancy/context.js';
import { buildRollupSource } from '../../lib/stats/rollup-query.js';
import { isoFromMs, round } from '../../lib/utils/format.js';
import { badRequest } from '../../lib/utils/http-error.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';
import { BUCKET_SECONDS, pickBucket } from '../../lib/stats/buckets.js';
import { throttleSource } from '../../lib/stats/throttles.js';

const MAX_POINTS = 2000;

export async function getTimeseries(c: Context) {
  const params = c.req.query();
  const range = parseTimeRange(params);
  const bucket = params.bucket || pickBucket(range);
  const step = BUCKET_SECONDS[bucket];
  if (!step) throw badRequest(`Invalid bucket: ${bucket}`);
  const stepMs = step * 1000;
  const first = Math.floor(range.from / stepMs) * stepMs;
  if ((range.to - first) / stepMs > MAX_POINTS) throw badRequest('Too many buckets for this range');

  const source = buildRollupSource({
    range,
    bucketSeconds: step,
    functionName: params.function || undefined,
    useRollup: step >= 3600,
  });
  const rows = await dataQuery<{ bucket_ms: number; invocations: number; errors: number; quantiles: number[] }>(
    c,
    `SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms,
       sum(invocations) AS invocations,
       sum(errors) AS errors,
       quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q) AS quantiles
     FROM (${source.sql})
     GROUP BY bucket
     ORDER BY bucket`,
    source.params,
  );

  const throttleQuery = throttleSource({ range, bucketSeconds: step, functionName: params.function || undefined });
  const throttleRows = await dataQuery<{ bucket_ms: number; throttles: number }>(
    c,
    `SELECT toUnixTimestamp(bucket) * 1000 AS bucket_ms, sum(throttles) AS throttles FROM (${throttleQuery.sql}) GROUP BY bucket`,
    throttleQuery.params,
  );
  const throttles = new Map(throttleRows.map((row) => [row.bucket_ms, row.throttles]));

  const byBucket = new Map(rows.map((row) => [row.bucket_ms, row]));
  const items = [];
  for (let ts = first; ts < range.to; ts += stepMs) {
    const row = byBucket.get(ts);
    items.push({
      ts: isoFromMs(ts),
      invocations: row?.invocations ?? 0,
      errors: row?.errors ?? 0,
      p95_ms: row ? round(row.quantiles[1], 1) : 0,
      throttles: throttles.get(ts) ?? 0,
    });
  }
  return c.json({ items });
}
