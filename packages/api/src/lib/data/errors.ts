import { failureKind } from '@ivy/spans';
import { projectFilter } from '../clickhouse/scoped.js';
import { THROTTLED_ERROR_TYPE, THROTTLED_MESSAGE, throttleSource } from '../stats/throttles.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { isoFromMs } from '../utils/format.js';
import type { TimeRange } from '../utils/time-range.js';
import { ERROR_GROUP_COLUMNS } from './error-grouping.js';
import { projectFields, type ProjectNames } from './projects.js';

/** How many of a group's distinct messages the list carries (most frequent first). */
export const TOP_MESSAGES = 5;

interface ErrorGroupRow {
  project_id: string;
  fingerprint: string;
  function: string;
  error_type: string;
  error_template: string;
  latest_message: string;
  count: number;
  variants: number;
  first_seen_ms: number;
  last_seen_ms: number;
  sample_trace_id: string;
  failure_phase: string;
  top: Array<[message: string, count: number, traceId: string, lastMs: number]>;
}

/**
 * Error groups: one per fingerprint (function, error type, code location and message template); workspace-wide
 * scopes also group by project. Each carries how many distinct raw messages it has and the most frequent ones.
 */
export async function errorGroups(scope: DataScope, range: TimeRange, fn?: string, projects?: ProjectNames) {
  const byProject = scope.projectId === null;
  const project = byProject ? 'project_id, ' : '';
  const rows = await scopedDataQuery<ErrorGroupRow>(
    scope,
    `SELECT ${project}fingerprint, function,
       argMax(error_type, last_ms) AS error_type,
       any(error_template) AS error_template,
       argMax(error_message, last_ms) AS latest_message,
       sum(n) AS count,
       count() AS variants,
       min(first_ms) AS first_seen_ms,
       max(last_ms) AS last_seen_ms,
       argMax(trace_id, last_ms) AS sample_trace_id,
       argMax(failure_phase, last_ms) AS failure_phase,
       arraySlice(arraySort(m -> (-m.2, -m.4), groupArray((error_message, n, trace_id, last_ms))), 1, ${TOP_MESSAGES}) AS top
     FROM (
       SELECT ${project}fingerprint, function, error_message,
         any(error_type) AS error_type, any(error_template) AS error_template,
         count() AS n,
         toUnixTimestamp64Milli(min(ts)) AS first_ms, toUnixTimestamp64Milli(max(ts)) AS last_ms,
         argMax(trace_id, ts) AS trace_id, argMax(failure_phase, ts) AS failure_phase
       FROM (
         SELECT ${project}ts, function, error_type, error_frame, error_message, trace_id, failure_phase, ${ERROR_GROUP_COLUMNS}
         FROM invocations
         WHERE tenant_id = {tenant:String} ${projectFilter(queryScope(scope), 'project_id')}
           AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
           AND status = 'error'
           ${fn ? 'AND function = {function:String}' : ''}
       )
       GROUP BY ${project}fingerprint, function, error_message
     )
     GROUP BY ${project}fingerprint, function
     ORDER BY count DESC, last_seen_ms DESC
     LIMIT 500`,
    { from: range.from, to: range.to, function: fn ?? '' },
  );
  const groups = rows.map((row) => ({
    fingerprint: row.fingerprint,
    function: row.function,
    ...(byProject ? projectFields(row.project_id, projects) : {}),
    error_type: row.error_type || 'Error',
    error_message: row.latest_message,
    error_template: row.error_template,
    count: Number(row.count),
    variants: Number(row.variants),
    top_messages: row.top.map(([message, count, traceId, lastMs]) => ({
      message,
      count: Number(count),
      sample_trace_id: traceId,
      last_seen: isoFromMs(Number(lastMs)),
    })),
    first_seen: isoFromMs(row.first_seen_ms),
    last_seen: isoFromMs(row.last_seen_ms),
    sample_trace_id: row.sample_trace_id as string | null,
    kind: 'error' as 'error' | 'throttle',
    failure_kind: failureKind(row.error_type, row.failure_phase),
  }));

  // One synthetic group per throttled function: throttled requests never reach the function, so there is no trace.
  const throttles = throttleSource({ scope: queryScope(scope), range, functionName: fn, byProject });
  const throttled = await scopedDataQuery<{ project_id: string; function: string; region: string; throttles: number; first_ms: number; last_ms: number }>(
    scope,
    throttles.sql,
    throttles.params,
  );
  for (const row of throttled) {
    groups.push({
      fingerprint: `throttled:${row.region}:${row.function}`,
      function: row.function,
      ...(byProject ? projectFields(row.project_id, projects) : {}),
      error_type: THROTTLED_ERROR_TYPE,
      error_message: THROTTLED_MESSAGE,
      error_template: THROTTLED_MESSAGE,
      count: row.throttles,
      variants: 1,
      top_messages: [],
      first_seen: isoFromMs(row.first_ms),
      last_seen: isoFromMs(row.last_ms),
      sample_trace_id: null,
      kind: 'throttle',
      failure_kind: null,
    });
  }
  return groups.sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen));
}
