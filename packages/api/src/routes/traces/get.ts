import type { Context } from 'hono';
import { query } from '../../lib/clickhouse/client.js';
import { tenantOf } from '../../lib/clickhouse/tenant.js';
import { normalizeKind, normalizeStatus } from '../../lib/traces/otel.js';
import { isTraceId, traceIdTimestamp } from '../../lib/traces/trace-id.js';
import { isoFromMs, round } from '../../lib/utils/format.js';

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

function fetchSpans(tenant: string, traceId: string, around?: number) {
  const timeFilter =
    around === undefined
      ? ''
      : 'AND Timestamp >= toDateTime({lo:UInt32}) AND Timestamp <= toDateTime({hi:UInt32})';
  return query<SpanRow>(
    `SELECT SpanId AS span_id, ParentSpanId AS parent_span_id, SpanName AS name, SpanKind AS kind,
       ServiceName AS service, toUnixTimestamp64Milli(Timestamp) AS start_ms, Duration AS duration_ns,
       StatusCode AS status_code, StatusMessage AS status_message,
       SpanAttributes AS attributes, ResourceAttributes AS resource,
       arrayMap(t -> toUnixTimestamp64Milli(t), \`Events.Timestamp\`) AS event_ts_ms,
       \`Events.Name\` AS event_names, \`Events.Attributes\` AS event_attributes
     FROM otel_traces
     WHERE TenantId = {tenant:String} AND TraceId = {trace_id:String} ${timeFilter}
     ORDER BY Timestamp, SpanId`,
    { tenant, trace_id: traceId, lo: (around ?? 0) - WINDOW_S, hi: (around ?? 0) + WINDOW_S },
  );
}

export async function getTrace(c: Context) {
  const traceId = (c.req.param('traceId') ?? '').toLowerCase();
  if (!isTraceId(traceId)) return c.json({ error: 'Trace not found' }, 404);

  const tenant = tenantOf(c);
  const around = traceIdTimestamp(traceId);
  let rows = around === undefined ? [] : await fetchSpans(tenant, traceId, around);
  if (rows.length === 0) rows = await fetchSpans(tenant, traceId);
  if (rows.length === 0) return c.json({ error: 'Trace not found' }, 404);

  return c.json({
    trace_id: traceId,
    spans: rows.map((row) => {
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
    }),
  });
}
