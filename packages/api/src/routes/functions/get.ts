import type { Context } from 'hono';
import { dataQuery } from '../../lib/tenancy/context.js';
import { buildRollupSource } from '../../lib/stats/rollup-query.js';
import { isoFromMs, round } from '../../lib/utils/format.js';
import { parseTimeRange } from '../../lib/utils/time-range.js';

interface FunctionRow {
  function: string;
  region: string;
  invocations: number;
  errors: number;
  cold_starts: number;
  duration_sum: number;
  last_invoked_ms: number;
  quantiles: [number, number, number];
}

export async function getFunctions(c: Context) {
  const range = parseTimeRange(c.req.query());
  const source = buildRollupSource({ range, useRollup: true });
  const rows = await dataQuery<FunctionRow>(
    c,
    `SELECT function, region,
       sum(invocations) AS invocations,
       sum(errors) AS errors,
       sum(cold_starts) AS cold_starts,
       sum(duration_sum) AS duration_sum,
       toUnixTimestamp64Milli(max(last_invoked)) AS last_invoked_ms,
       quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q) AS quantiles
     FROM (${source.sql})
     GROUP BY function, region
     ORDER BY invocations DESC, function`,
    source.params,
  );

  return c.json({
    items: rows.map((row) => ({
      name: row.function,
      region: row.region,
      invocations: row.invocations,
      errors: row.errors,
      error_rate: row.invocations ? round(row.errors / row.invocations, 4) : 0,
      cold_starts: row.cold_starts,
      avg_ms: row.invocations ? round(row.duration_sum / row.invocations, 1) : 0,
      p50_ms: round(row.quantiles[0], 1),
      p95_ms: round(row.quantiles[1], 1),
      p99_ms: round(row.quantiles[2], 1),
      last_invoked: isoFromMs(row.last_invoked_ms),
    })),
  });
}
