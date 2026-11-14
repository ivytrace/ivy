import type { Span, Trace } from "@ivy/spans";

/** Payload-like attributes the views show; capped so a tool result stays small. */
const LARGE_ATTRIBUTES = ["ivy.payload.request", "ivy.payload.response", "ivy.http.request.headers", "ivy.http.response.headers"];
const SOURCE_CUT = /…\[truncated (\d+) bytes\]$/;

export const MAX_VIEW_SPANS = 2000;
export const MAX_ATTRIBUTE_CHARS = 8 * 1024;

function capAttributes(span: Span): Span {
  let truncated = false;
  const attributes = { ...span.attributes };
  for (const key of LARGE_ATTRIBUTES) {
    const value = attributes[key];
    if (!value || value.length <= MAX_ATTRIBUTE_CHARS) continue;
    const already = Number(SOURCE_CUT.exec(value)?.[1] ?? 0);
    const body = value.replace(SOURCE_CUT, "");
    attributes[key] = `${body.slice(0, MAX_ATTRIBUTE_CHARS)}…[truncated ${body.length - MAX_ATTRIBUTE_CHARS + already} bytes]`;
    truncated = true;
  }
  if (truncated) attributes["ivy.payload.truncated"] = "true";
  return { ...span, attributes };
}

/**
 * The trace as sent to a view (`structuredContent`): the API shape, with payloads capped at 8 KB
 * (same truncation marker as the layer, so the dashboard components show "truncated") and at most
 * 2000 spans. Payloads were redacted at ingest; nothing is added that the text tools don't return.
 */
export function viewTrace(trace: Trace): Trace & { omitted_spans: number } {
  const spans = [...trace.spans].sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_VIEW_SPANS);
  return { trace_id: trace.trace_id, spans: spans.map(capAttributes), omitted_spans: trace.spans.length - spans.length };
}
