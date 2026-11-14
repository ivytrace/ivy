export type SpanKind = "SERVER" | "CLIENT" | "CONSUMER" | "PRODUCER" | "INTERNAL" | string;
export type StatusCode = "OK" | "ERROR" | "UNSET";

export interface SpanEvent {
  ts: string;
  name: string;
  attributes: Record<string, string>;
}

export interface Span {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: SpanKind;
  service: string;
  start: string;
  end: string;
  duration_ms: number;
  status_code: StatusCode;
  status_message: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  events: SpanEvent[];
}

export interface Trace {
  trace_id: string;
  spans: Span[];
}
