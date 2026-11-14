import { PayloadPreview } from "@/components/stats/payload-preview";
import { ErrorBlock } from "@/components/trace/error-block";
import { LlmDetails } from "@/components/trace/llm-details";
import { describeSpan, formatCount, getException, type CollapsedInfo } from "@/lib/spans/services";
import type { Span } from "@/lib/spans/types";
import { formatDuration, formatTimestamp } from "@/lib/utils/format";

function collapsedFields(c: CollapsedInfo) {
  return [
    { label: "Calls", value: formatCount(c.count) },
    { label: "Total", value: formatDuration(c.totalMs) },
    { label: "Average", value: formatDuration(c.avgMs) },
    { label: "Max", value: formatDuration(c.maxMs) },
    { label: "Min", value: formatDuration(c.minMs) },
    { label: "Errors (kept in full)", value: formatCount(c.errors) },
    { label: "Kept in full", value: formatCount(c.kept) },
    ...(c.signature ? [{ label: "Signature", value: c.signature }] : []),
  ];
}

export function SpanFields({ span }: { span: Span }) {
  const d = describeSpan(span);
  const fields = [
    { label: "Service", value: d.serviceLabel },
    ...d.fields,
    ...(d.collapsed ? collapsedFields(d.collapsed) : []),
    { label: "Started", value: formatTimestamp(span.start) },
    { label: d.collapsed ? "First → last" : "Duration", value: formatDuration(span.duration_ms) },
    { label: "Span", value: span.span_id },
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-xs">
      {fields.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-muted-foreground">{f.label}</dt>
          <dd className="break-all font-mono">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SpanDetails({ span }: { span: Span }) {
  const d = describeSpan(span);
  const exception = getException(span);
  const known = new Set([
    "ivy.payload.request",
    "ivy.payload.response",
    "ivy.http.request.headers",
    "ivy.http.response.headers",
  ]);
  const attributes = Object.fromEntries(Object.entries(span.attributes).filter(([k]) => !known.has(k)));

  return (
    <div className="flex flex-col gap-3">
      {d.collapsed && (
        <p className="text-xs text-muted-foreground">
          {formatCount(d.collapsed.count)} similar calls were summarised in this span to keep the trace small. The first
          and slowest calls, and every failing one, are kept as their own spans.
        </p>
      )}
      <SpanFields span={span} />
      {exception && !d.isInvocation && <ErrorBlock exception={exception} />}
      {d.llm && <LlmDetails llm={d.llm} />}
      <PayloadPreview title={d.isInvocation ? "Event" : "Request"} value={d.request} truncated={d.truncated} />
      <PayloadPreview title="Request headers" value={d.requestHeaders} defaultOpen={false} />
      <PayloadPreview title={d.isInvocation ? "Return value" : "Response"} value={d.response} truncated={d.truncated} />
      <PayloadPreview title="Response headers" value={d.responseHeaders} defaultOpen={false} />
      <PayloadPreview title="All attributes" value={attributes} defaultOpen={false} />
    </div>
  );
}
