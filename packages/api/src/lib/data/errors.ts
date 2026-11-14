import { projectFilter } from '../clickhouse/scoped.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { isoFromMs } from '../utils/format.js';
import type { TimeRange } from '../utils/time-range.js';
import { projectFields, type ProjectNames } from './projects.js';

interface ErrorGroupRow {
  project_id: string;
  fingerprint: string;
  function: string;
  error_type: string;
  error_message: string;
  count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  sample_trace_id: string;
}

/** Error groups (fingerprint + function); workspace-wide scopes also group by project. */
export async function errorGroups(scope: DataScope, range: TimeRange, fn?: string, projects?: ProjectNames) {
  const byProject = scope.projectId === null;
  const rows = await scopedDataQuery<ErrorGroupRow>(
    scope,
    `SELECT ${byProject ? 'project_id, ' : ''}error_fingerprint AS fingerprint, function,
       argMax(error_type, ts) AS error_type,
       argMax(error_message, ts) AS error_message,
       count() AS count,
       toUnixTimestamp64Milli(min(ts)) AS first_seen_ms,
       toUnixTimestamp64Milli(max(ts)) AS last_seen_ms,
       argMax(trace_id, ts) AS sample_trace_id
     FROM invocations
     WHERE tenant_id = {tenant:String} ${projectFilter(queryScope(scope), 'project_id')}
       AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
       AND status = 'error'
       ${fn ? 'AND function = {function:String}' : ''}
     GROUP BY ${byProject ? 'project_id, ' : ''}fingerprint, function
     ORDER BY count DESC, last_seen_ms DESC
     LIMIT 500`,
    { from: range.from, to: range.to, function: fn ?? '' },
  );
  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    function: row.function,
    ...(byProject ? projectFields(row.project_id, projects) : {}),
    error_type: row.error_type || 'Error',
    error_message: row.error_message,
    count: row.count,
    first_seen: isoFromMs(row.first_seen_ms),
    last_seen: isoFromMs(row.last_seen_ms),
    sample_trace_id: row.sample_trace_id,
  }));
}
