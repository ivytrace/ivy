import type { AttrValue, Attributes, Span } from '../tracer/span.js';

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: { timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }[];
  status: { code: number; message?: string };
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[];
}

export interface OtlpExportRequest {
  resourceSpans: OtlpResourceSpans[];
}

export const SCOPE = { name: 'ivy-layer', version: '0.1.0' };

export function toAnyValue(v: AttrValue): OtlpAnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => toAnyValue(x)) } };
  return { stringValue: String(v) };
}

export function toKeyValues(attrs: Attributes): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const key in attrs) {
    const v = attrs[key];
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
    out.push({ key, value: toAnyValue(v) });
  }
  return out;
}

/** Converts epoch milliseconds (with sub-ms fraction) to a nanosecond decimal string. */
export function msToNanos(ms: number): string {
  const micros = BigInt(Math.round(ms * 1000));
  return (micros * 1000n).toString();
}

export function encodeSpan(span: Span): OtlpSpan {
  const end = span.endMs ?? span.startMs;
  const out: OtlpSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: msToNanos(span.startMs),
    endTimeUnixNano: msToNanos(Math.max(end, span.startMs)),
    attributes: toKeyValues(span.attributes),
    events: span.events.map((e) => ({
      timeUnixNano: msToNanos(e.timeMs),
      name: e.name,
      attributes: toKeyValues(e.attributes),
    })),
    status: span.status.message ? { code: span.status.code, message: span.status.message } : { code: span.status.code },
  };
  if (span.parentSpanId) out.parentSpanId = span.parentSpanId;
  return out;
}

export function buildExportRequest(batches: { resource: OtlpKeyValue[]; spans: OtlpSpan[] }[]): OtlpExportRequest {
  const byResource = new Map<string, OtlpResourceSpans>();
  for (const batch of batches) {
    const key = JSON.stringify(batch.resource);
    let rs = byResource.get(key);
    if (!rs) {
      rs = { resource: { attributes: batch.resource }, scopeSpans: [{ scope: SCOPE, spans: [] }] };
      byResource.set(key, rs);
    }
    rs.scopeSpans[0].spans.push(...batch.spans);
  }
  return { resourceSpans: [...byResource.values()] };
}
