import {
  collapsedInfo,
  describeLlm,
  formatCount,
  describeSpan,
  isAwsSpan,
  isHttpSpan,
  isInvocationSpan,
  requestedTools,
  triggerLabel,
  type LlmSpan,
  type Span,
} from "@ivy/spans";
import { ms } from "../text/text.js";

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
  const host = a["server.address"] ?? span.name.split(" ")[1] ?? "";
  return a["http.route"] ? `${host}${a["http.route"]}` : host;
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
 * LLM spans, e.g. `ai.generateText.doGenerate gpt-4o-mini 812→24 tok tool:getOrder` or
 * `ai.streamText.doStream claude-haiku-4-5 164→38 tok (ttft 318ms)`.
 */
function llmLabel(span: Span, l: LlmSpan): string {
  if (l.kind === "tool") return l.tool && !span.name.includes(l.tool.name) ? `${span.name} ${l.tool.name}` : span.name;
  const parts = [span.name];
  if (l.model && !span.name.includes(l.model)) parts.push(l.model);
  if (l.inputTokens !== undefined || l.outputTokens !== undefined) parts.push(`${l.inputTokens ?? 0}→${l.outputTokens ?? 0} tok`);
  if (l.ttftMs !== undefined) parts.push(`(ttft ${ms(l.ttftMs)})`);
  const tools = requestedTools(l);
  if (tools.length) parts.push(tools.map((t) => `tool:${t}`).join(" "));
  if (l.finishReason && /length|filter|error/.test(l.finishReason)) parts.push(`finish:${l.finishReason}`);
  return parts.join(" ");
}

/** Short operation name of an LLM span for matching across traces, e.g. `ai.generateText gpt-4o-mini`. */
function llmKey(span: Span, l: LlmSpan): string {
  if (l.kind === "tool") return l.tool && !span.name.includes(l.tool.name) ? `${span.name} ${l.tool.name}` : span.name;
  return l.model && !span.name.includes(l.model) ? `${span.name} ${l.model}` : span.name;
}

/**
 * One-line, service-aware description of a span, e.g. `DynamoDB.GetItem checkout-users (1 item returned)`
 * or `POST api.stripe.com/v1/payment_intents → 402`. Built on the UI's describers (@ivy/spans).
 */
export function spanLabel(span: Span): string {
  if (isInvocationSpan(span)) return `${span.name} [invocation] ${triggerText(span)}`;
  const collapsed = collapsedInfo(span);
  if (collapsed) {
    const c = collapsed;
    const stats = [
      `first→last ${ms(span.duration_ms)}`,
      `total ${ms(c.totalMs)}`,
      `avg ${ms(c.avgMs)}`,
      `min ${ms(c.minMs)}`,
      `max ${ms(c.maxMs)}`,
      `${c.errors} error${c.errors === 1 ? "" : "s"}`,
      `${c.kept} kept`,
    ];
    return `${callKey(span)} × ${formatCount(c.count)} (${stats.join(", ")})`;
  }

  const llm = describeLlm(span);
  if (llm) return llmLabel(span, llm);

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
  const llm = describeLlm(span);
  if (llm) return llmKey(span, llm);
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
