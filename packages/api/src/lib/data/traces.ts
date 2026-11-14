import { mergeUpdateSpans } from '@ivy/spans';
import { projectFilter } from '../clickhouse/scoped.js';
import { queryScope, scopedDataQuery, type DataScope } from '../tenancy/context.js';
import { normalizeKind, normalizeStatus } from '../traces/otel.js';
import { isTraceId, traceIdTimestamp } from '../traces/trace-id.js';
import { isoFromMs, round } from '../utils/format.js';

interface SpanRow {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  service: string;
  start_ms: number;
  duration_ns: number;
  status_code: string;
  status_message: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  event_ts_ms: number[];
  event_names: string[];
  event_attributes: Record<string, string>[];
}

const WINDOW_S = 3600;

function fetchSpans(scope: DataScope, traceId: string, around?: number) {
  const timeFilter = around === undefined ? '' : 'AND Timestamp >= toDateTime({lo:UInt32}) AND Timestamp <= toDateTime({hi:UInt32})';
  return scopedDataQuery<SpanRow>(
    scope,
    `SELECT SpanId AS span_id, ParentSpanId AS parent_span_id, SpanName AS name, SpanKind AS kind,
       ServiceName AS service, toUnixTimestamp64Milli(Timestamp) AS start_ms, Duration AS duration_ns,
       StatusCode AS status_code, StatusMessage AS status_message,
       SpanAttributes AS attributes, ResourceAttributes AS resource,
       arrayMap(t -> toUnixTimestamp64Milli(t), \`Events.Timestamp\`) AS event_ts_ms,
       \`Events.Name\` AS event_names, \`Events.Attributes\` AS event_attributes
     FROM otel_traces
     WHERE TenantId = {tenant:String} ${projectFilter(queryScope(scope), 'ProjectId')} AND TraceId = {trace_id:String} ${timeFilter}
     ORDER BY Timestamp, SpanId`,
    { trace_id: traceId, lo: (around ?? 0) - WINDOW_S, hi: (around ?? 0) + WINDOW_S },
  );
}

/** All spans of a trace within the scope, or null when there are none. */
export async function getTrace(scope: DataScope, rawTraceId: string) {
  const traceId = rawTraceId.toLowerCase();
  if (!isTraceId(traceId)) return null;

  const around = traceIdTimestamp(traceId);
  let rows = around === undefined ? [] : await fetchSpans(scope, traceId, around);
  if (rows.length === 0) rows = await fetchSpans(scope, traceId);
  if (rows.length === 0) return null;

  return {
    trace_id: traceId,
    // Update spans (late Lambda report data from the extension) are folded into their invocation span.
    spans: mergeUpdateSpans(rows.map((row) => {
      const durationMs = row.duration_ns / 1e6;
      return {
        span_id: row.span_id,
        parent_span_id: row.parent_span_id,
        name: row.name,
        kind: normalizeKind(row.kind),
        service: row.service,
        start: isoFromMs(row.start_ms),
        end: isoFromMs(row.start_ms + durationMs),
        duration_ms: round(durationMs),
        status_code: normalizeStatus(row.status_code),
        status_message: row.status_message,
        attributes: row.attributes,
        resource: row.resource,
        events: row.event_names.map((name, i) => ({
          ts: isoFromMs(row.event_ts_ms[i]),
          name,
          attributes: row.event_attributes[i],
        })),
      };
    })),
  };
}
