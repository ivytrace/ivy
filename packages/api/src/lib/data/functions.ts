import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { buildRollupSource } from '../stats/rollup-query.js';
import { isoFromMs, round } from '../utils/format.js';
import type { TimeRange } from '../utils/time-range.js';
import { projectFields, type ProjectNames } from './projects.js';

interface FunctionRow {
  project_id: string;
  function: string;
  region: string;
  invocations: number;
  errors: number;
  cold_starts: number;
  duration_sum: number;
  last_invoked_ms: number;
  quantiles: [number, number, number];
}

/**
 * Function overview for a range: one item per function and region (and project, for a
 * workspace-wide scope, where items carry `project_id` and `project`).
 */
export async function functionSummaries(scope: DataScope, range: TimeRange, projects?: ProjectNames) {
  const byProject = scope.projectId === null;
  const source = buildRollupSource({ scope: queryScope(scope), range, useRollup: true, byProject });
  const keys = byProject ? 'project_id, function, region' : 'function, region';
  const rows = await scopedDataQuery<FunctionRow>(
    scope,
    `SELECT ${keys},
       sum(invocations) AS invocations,
       sum(errors) AS errors,
       sum(cold_starts) AS cold_starts,
       sum(duration_sum) AS duration_sum,
       toUnixTimestamp64Milli(max(last_invoked)) AS last_invoked_ms,
       quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q) AS quantiles
     FROM (${source.sql})
     GROUP BY ${keys}
     ORDER BY invocations DESC, function`,
    source.params,
  );
  return rows.map((row) => ({
    name: row.function,
    region: row.region,
    ...(byProject ? projectFields(row.project_id, projects) : {}),
    invocations: row.invocations,
    errors: row.errors,
    error_rate: row.invocations ? round(row.errors / row.invocations, 4) : 0,
    cold_starts: row.cold_starts,
    avg_ms: row.invocations ? round(row.duration_sum / row.invocations, 1) : 0,
    p50_ms: round(row.quantiles[0], 1),
    p95_ms: round(row.quantiles[1], 1),
    p99_ms: round(row.quantiles[2], 1),
    last_invoked: isoFromMs(row.last_invoked_ms),
  }));
}
