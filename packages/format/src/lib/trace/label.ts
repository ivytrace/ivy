import { describeSpan, isAwsSpan, isHttpSpan, isInvocationSpan, triggerLabel, type Span } from "@ivy/spans";

function httpTarget(span: Span): string {
  const a = span.attributes;
  if (a["url.full"]) {
    try {
      const url = new URL(a["url.full"]);
      return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      // fall through
    }
  }
  return a["server.address"] ?? span.name.split(" ")[1] ?? "";
}

/** The trigger part of an invocation, e.g. `API Gateway POST /orders → 402` or `SQS`. */
export function triggerText(span: Span): string {
  const a = span.attributes;
  const trigger = triggerLabel(a["ivy.trigger.source"]);
  const method = a["http.request.method"];
  const route = a["http.route"] || a["url.path"];
  const status = a["http.response.status_code"];
  if (!method || !route) return trigger;
  return `${trigger} ${method} ${route}${status ? ` → ${status}` : ""}`;
}

/**
 * One-line, service-aware description of a span, e.g. `DynamoDB.GetItem checkout-users (1 item returned)`
 * or `POST api.stripe.com/v1/payment_intents → 402`. Built on the UI's describers (@ivy/spans).
 */
export function spanLabel(span: Span): string {
  if (isInvocationSpan(span)) return `${span.name} [invocation] ${triggerText(span)}`;

  if (isAwsSpan(span)) {
    const d = describeSpan(span);
    const status = span.attributes["http.response.status_code"];
    const parts = [`${d.serviceLabel}.${d.operation}`];
    if (d.target) parts.push(d.target);
    if (d.note && !d.note.startsWith("message ")) parts.push(`(${d.note})`);
    if (status && status !== "200") parts.push(`→ ${status}`);
    return parts.join(" ");
  }

  if (isHttpSpan(span)) {
    const a = span.attributes;
    const method = a["http.request.method"] || span.name.split(" ")[0] || "GET";
    const status = a["http.response.status_code"];
    return `${method} ${httpTarget(span)}${status ? ` → ${status}` : ""}`;
  }

  return span.kind === "INTERNAL" || !span.kind ? span.name : `${span.name} (${span.kind.toLowerCase()})`;
}

const ID_SEGMENT = /^(\d+|(?=[^/]*\d)[^/]{8,})$/;

/** Replaces ID-like path segments (numbers, long tokens containing digits) with `:id`. */
const withoutIds = (path: string) =>
  path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");

/** Stable identity of a call for matching across traces (no counts, IDs or status codes). */
export function callKey(span: Span): string {
  if (isInvocationSpan(span)) return `invocation ${span.name}`;
  if (isAwsSpan(span)) {
    const d = describeSpan(span);
    return `${d.serviceLabel}.${d.operation}${d.target ? ` ${withoutIds(d.target)}` : ""}`;
  }
  if (isHttpSpan(span)) {
    const method = span.attributes["http.request.method"] || span.name.split(" ")[0];
    return `${method} ${withoutIds(httpTarget(span))}`;
  }
  return span.name;
}

export const statusText = (span: Span) => (span.status_code === "ERROR" ? "ERROR" : "ok");
