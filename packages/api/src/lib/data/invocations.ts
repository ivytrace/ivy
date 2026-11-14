import { failureKind } from '@ivy/spans';
import { projectFilter } from '../clickhouse/scoped.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { emptyToNull, isoFromMs, round, zeroToNull } from '../utils/format.js';
import { badRequest } from '../utils/http-error.js';
import type { TimeRange } from '../utils/time-range.js';

interface InvocationRow {
  ts_ms: number;
  trace_id: string;
  span_id: string;
  function: string;
  region: string;
  status: 'ok' | 'error';
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
}

export interface InvocationFilters {
  function?: string;
  status?: string;
  q?: string;
  cursor?: string;
  limit?: string | number;
}

export function parseLimit(value: string | number | undefined): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest(`Invalid limit: ${value}`);
  return Math.min(limit, 500);
}

/** Invocations, newest first, with keyset pagination on (ts, span_id). */
export async function listInvocations(scope: DataScope, range: TimeRange, filters: InvocationFilters) {
  const limit = parseLimit(filters.limit);
  const where = [
    'tenant_id = {tenant:String}',
    'ts >= fromUnixTimestamp64Milli({from:Int64})',
    'ts < fromUnixTimestamp64Milli({to:Int64})',
  ];
  const project = projectFilter(queryScope(scope), 'project_id');
  if (project) where.push(project.replace(/^AND /, ''));
  const queryParams: Record<string, unknown> = { from: range.from, to: range.to, limit: limit + 1 };

  if (filters.function) {
    where.push('function = {function:String}');
    queryParams.function = filters.function;
  }
  if (filters.status) {
    if (filters.status !== 'ok' && filters.status !== 'error') throw badRequest(`Invalid status: ${filters.status}`);
    where.push('status = {status:String}');
    queryParams.status = filters.status;
  }
  const q = filters.q?.trim();
  if (q) {
    where.push(
      `(trace_id = lower({q:String}) OR request_id = {q:String}
        OR positionCaseInsensitive(error_message, {q:String}) > 0
        OR positionCaseInsensitive(http_path, {q:String}) > 0)`,
    );
    queryParams.q = q;
  }
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    where.push('(ts, span_id) < (fromUnixTimestamp64Milli({cursor_ts:Int64}), {cursor_span:String})');
    queryParams.cursor_ts = cursor.ts;
    queryParams.cursor_span = cursor.spanId;
  }

  const rows = await scopedDataQuery<InvocationRow>(
    scope,
    `SELECT toUnixTimestamp64Milli(ts) AS ts_ms, trace_id, span_id, function, region, status, duration_ms,
       cold_start, request_id, trigger, http_method, http_path, http_status, error_type, error_message, memory_used_mb,
       memory_limit_mb, failure_phase, synthetic, init_duration_ms
     FROM invocations
     WHERE ${where.join(' AND ')}
     ORDER BY ts DESC, span_id DESC
     LIMIT {limit:UInt32}`,
    queryParams,
  );

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      trace_id: row.trace_id,
      span_id: row.span_id,
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
    })),
    next_cursor: rows.length > limit && last ? encodeCursor({ ts: last.ts_ms, spanId: last.span_id }) : null,
  };
}
