import { failureKind } from '@ivy/spans';
import { projectFilter } from '../clickhouse/scoped.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { emptyToNull, isoFromMs, round, zeroToNull } from '../utils/format.js';
import { badRequest } from '../utils/http-error.js';
import type { TimeRange } from '../utils/time-range.js';
import { ERROR_FINGERPRINT_EXPR } from './error-grouping.js';
import { attributeTraceIds, parseInvocationSearch } from './invocation-search.js';
import { projectFields, type ProjectNames } from './projects.js';

interface InvocationRow {
  project_id?: string;
  ts_ms: number;
  trace_id: string;
  span_id: string;
  function: string;
  region: string;
  status: 'ok' | 'error' | 'in_progress';
  duration_ms: number;
  cold_start: boolean;
  request_id: string;
  trigger: string;
  http_method: string;
  http_path: string;
  http_status: number;
  error_type: string;
  error_message: string;
  memory_used_mb: number;
  memory_limit_mb: number;
  failure_phase: string;
  synthetic: boolean;
  init_duration_ms: number;
  deadline_ms: number;
  last_seen_ms: number;
}

export interface InvocationFilters {
  function?: string;
  status?: string;
  /** Free text plus `key=value` span attribute terms (`invocation-search.ts`). */
  q?: string;
  cursor?: string;
  limit?: string | number;
  /** Comma-separated span IDs: only these invocations, in their current state (Live refreshes in-progress rows). */
  ids?: string;
  /** An error group's fingerprint (`GET /errors`): only the failed invocations in that group. */
  group?: string;
}

const STATUSES = ['ok', 'error', 'in_progress'];
const MAX_IDS = 100;
/** How far a final invocation span's start may lie from its in-progress record's (tracer vs. extension clock). */
const FINAL_SLACK_MS = 60_000;

export function parseLimit(value: string | number | undefined): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest(`Invalid limit: ${value}`);
  return Math.min(limit, 500);
}

export function parseIds(value: string | undefined): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  const ids = [...new Set(value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (ids.length > MAX_IDS || ids.some((id) => !/^[0-9a-f]{16}$/.test(id))) throw badRequest(`Invalid ids: up to ${MAX_IDS} span IDs (16 hex chars)`);
  return ids;
}

const FINAL_COLUMNS = `toUnixTimestamp64Milli(ts) AS ts_ms, trace_id, span_id, function, region, status, duration_ms,
       cold_start, request_id, trigger, http_method, http_path, http_status, error_type, error_message, memory_used_mb,
       memory_limit_mb, failure_phase, synthetic, init_duration_ms, toInt64(0) AS deadline_ms, toInt64(0) AS last_seen_ms`;

const IN_PROGRESS_COLUMNS = `toUnixTimestamp64Milli(ts) AS ts_ms, trace_id, span_id, function, region, 'in_progress' AS status,
       toFloat64(toUnixTimestamp64Milli(last_seen) - toUnixTimestamp64Milli(ts)) AS duration_ms, cold_start, request_id, trigger,
       '' AS http_method, '' AS http_path, toUInt16(0) AS http_status, '' AS error_type, '' AS error_message,
       toFloat32(0) AS memory_used_mb, memory_limit_mb, '' AS failure_phase, false AS synthetic, toFloat32(0) AS init_duration_ms,
       toUnixTimestamp64Milli(deadline) AS deadline_ms, toUnixTimestamp64Milli(last_seen) AS last_seen_ms`;

/**
 * Invocations, newest first, with keyset pagination on (ts, span_id). A workspace-wide scope reads
 * every project, and its items carry `project_id` and `project`.
 *
 * Long-running invocations the extension reported as in progress come from `invocations_in_progress` until their
 * final span (same trace and span ID) is in `invocations`; they are never in `invocations` themselves.
 */
export async function listInvocations(scope: DataScope, range: TimeRange, filters: InvocationFilters, projects?: ProjectNames) {
  const byProject = scope.projectId === null;
  const limit = parseLimit(filters.limit);
  const ids = parseIds(filters.ids);
  const group = filters.group || undefined;
  if (group && !/^[0-9a-f]{1,16}$/.test(group)) throw badRequest(`Invalid group: ${group}`);
  // An error group holds only failed invocations.
  const status = group ? 'error' : filters.status || undefined;
  if (status && !STATUSES.includes(status)) throw badRequest(`Invalid status: ${status}`);

  const common = ['tenant_id = {tenant:String}'];
  const project = projectFilter(queryScope(scope), 'project_id');
  if (project) common.push(project.replace(/^AND /, ''));
  const queryParams: Record<string, unknown> = { from: range.from, to: range.to, limit: limit + 1, slack: FINAL_SLACK_MS };
  const inRange = ['ts >= fromUnixTimestamp64Milli({from:Int64})', 'ts < fromUnixTimestamp64Milli({to:Int64})'];
  const shared: string[] = [];

  if (filters.function) {
    shared.push('function = {function:String}');
    queryParams.function = filters.function;
  }
  if (ids) {
    shared.push('span_id IN {ids:Array(String)}');
    queryParams.ids = ids;
  }
  const search = parseInvocationSearch(filters.q);
  const q = search.text;
  if (q) queryParams.q = q;
  let attributeFilter: string | undefined;
  if (search.attributes.length) {
    const traces = attributeTraceIds(search.attributes, projectFilter(queryScope(scope), 'ProjectId'));
    attributeFilter = `trace_id IN (${traces.sql})`;
    Object.assign(queryParams, traces.params);
  }
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    shared.push('(ts, span_id) < (fromUnixTimestamp64Milli({cursor_ts:Int64}), {cursor_span:String})');
    queryParams.cursor_ts = cursor.ts;
    queryParams.cursor_span = cursor.spanId;
  }

  const finalWhere = [...common, ...inRange, ...shared];
  if (status && status !== 'in_progress') {
    finalWhere.push('status = {status:String}');
    queryParams.status = status;
  }
  if (group) {
    finalWhere.push(`${ERROR_FINGERPRINT_EXPR} = {group:String}`);
    queryParams.group = group;
  }
  if (q) {
    finalWhere.push(
      `(trace_id = lower({q:String}) OR request_id = {q:String}
        OR positionCaseInsensitive(error_message, {q:String}) > 0
        OR positionCaseInsensitive(http_path, {q:String}) > 0)`,
    );
  }
  if (attributeFilter) finalWhere.push(attributeFilter);
  const select = (columns: string) => `${byProject ? 'project_id, ' : ''}${columns}`;
  const branches: string[] = [];
  if (status !== 'in_progress') {
    branches.push(`SELECT ${select(FINAL_COLUMNS)} FROM invocations WHERE ${finalWhere.join(' AND ')}`);
  }
  if (!status || status === 'in_progress') {
    const pending = [...common, ...inRange, ...shared];
    if (q) pending.push('(trace_id = lower({q:String}) OR request_id = {q:String})');
    // Latest record per invocation, minus those whose final span has arrived.
    branches.push(
      `SELECT ${select(IN_PROGRESS_COLUMNS)} FROM (
         SELECT * FROM invocations_in_progress FINAL WHERE ${pending.join(' AND ')}
       ) AS p
       WHERE (trace_id, span_id) NOT IN (
         SELECT trace_id, span_id FROM invocations
         WHERE ${common.join(' AND ')}
           AND ts >= fromUnixTimestamp64Milli({from:Int64} - {slack:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64} + {slack:Int64})
           AND span_id IN (SELECT span_id FROM invocations_in_progress WHERE ${pending.join(' AND ')})
       )${attributeFilter ? `\n       AND ${attributeFilter}` : ''}`,
    );
  }

  const rows = await scopedDataQuery<InvocationRow>(
    scope,
    `SELECT * FROM (${branches.join('\n     UNION ALL\n     ')})
     ORDER BY ts_ms DESC, span_id DESC
     LIMIT {limit:UInt32}`,
    queryParams,
  );

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const inProgress = row.status === 'in_progress';
      return {
        trace_id: row.trace_id,
        span_id: row.span_id,
        ...(byProject ? projectFields(row.project_id ?? '', projects) : {}),
        ts: isoFromMs(row.ts_ms),
        function: row.function,
        region: row.region,
        status: row.status,
        duration_ms: round(row.duration_ms),
        cold_start: row.cold_start,
        request_id: row.request_id,
        trigger: row.trigger,
        http_method: emptyToNull(row.http_method),
        http_path: emptyToNull(row.http_path),
        http_status: zeroToNull(row.http_status),
        error_type: emptyToNull(row.error_type),
        error_message: emptyToNull(row.error_message),
        memory_used_mb: zeroToNull(round(row.memory_used_mb, 1)),
        memory_limit_mb: zeroToNull(row.memory_limit_mb),
        failure_phase: row.failure_phase === 'init' || row.failure_phase === 'invoke' ? row.failure_phase : null,
        failure_kind: row.status === 'error' ? failureKind(row.error_type, row.failure_phase) : null,
        synthetic: row.synthetic,
        init_duration_ms: zeroToNull(round(row.init_duration_ms)),
        deadline: inProgress && row.deadline_ms > 0 ? isoFromMs(row.deadline_ms) : null,
        last_seen: inProgress ? isoFromMs(row.last_seen_ms) : null,
      };
    }),
    next_cursor: rows.length > limit && last ? encodeCursor({ ts: last.ts_ms, spanId: last.span_id }) : null,
  };
}
