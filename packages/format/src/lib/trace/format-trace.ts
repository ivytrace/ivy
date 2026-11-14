import {
  collapsedCalls,
  collapsedInfo,
  describeLlm,
  droppedSpans,
  droppedSpansLabel,
  failureLabel,
  formatCount,
  getException,
  invocationResources,
  isInvocationSpan,
  llmUsage,
  missingTraceNote,
  spanFailureKind,
  type LlmMessage,
  type LlmPart,
  type Span,
  type SpanEvent,
  type Trace,
} from "@ivy/spans";
import { trimPayload } from "../payload/trim.js";
import { estimateTokens, ms, oneLine, plural } from "../text/text.js";
import { callKey, spanLabel, statusText, triggerText } from "./label.js";
import { buildTree, endMs, logEvents, rootInvocation, startMs, traceBounds, type TraceNode } from "./tree.js";

export type Detail = "summary" | "normal" | "full";

export interface FormatTraceOptions {
  /**
   * `summary`: span lines, errors, warn/error logs, no payloads.
   * `normal` (default): plus all logs, and payloads of the invocation, failed and 4xx/5xx calls.
   * `full`: payloads and HTTP headers of every span, longer stacks, no collapsing of repeated calls.
   */
  detail?: Detail;
  /** Approximate output budget in tokens (default 2000). The formatter sheds detail to fit; 0 = unlimited. */
  maxTokens?: number;
  /** Characters per payload before trimming (default 300 for normal, 1000 for full). */
  payloadChars?: number;
}

interface Settings {
  payloads: "none" | "key" | "all";
  payloadChars: number;
  headers: boolean;
  allLogs: boolean;
  logChars: number;
  stackFrames: number;
  collapse: boolean;
}

function settingsFor(detail: Detail, payloadChars?: number): Settings {
  switch (detail) {
    case "summary":
      return { payloads: "none", payloadChars: 0, headers: false, allLogs: false, logChars: 160, stackFrames: 2, collapse: true };
    case "full":
      return { payloads: "all", payloadChars: payloadChars ?? 1000, headers: true, allLogs: true, logChars: 1000, stackFrames: 10, collapse: false };
    default:
      return { payloads: "key", payloadChars: payloadChars ?? 300, headers: false, allLogs: true, logChars: 300, stackFrames: 4, collapse: true };
  }
}

interface Line {
  text: string;
  /** Kept when shedding lines to fit the budget (header, failed spans, their errors). */
  keep?: boolean;
}

const OFFSET_WIDTH = 9;
const DURATION_WIDTH = 8;
const GUTTER = " ".repeat(OFFSET_WIDTH + 1 + DURATION_WIDTH + 2);
const MIN_COLLAPSE = 3;
/** Frames of the Node runtime, the Lambda runtime and the Ivy layer's wrapper: never the cause. */
const RUNTIME_FRAME = /node:internal|\/var\/runtime\/|\/@ivy\/layer\//;

const columns = (offset: string, duration: string) => `${offset.padStart(OFFSET_WIDTH)} ${duration.padStart(DURATION_WIDTH)}  `;
const indent = (depth: number) => "  ".repeat(depth);
const isLog = (entry: Entry): entry is { log: SpanEvent; at: number } => "log" in entry;

type Entry = { node: TraceNode; at: number } | { log: SpanEvent; at: number };

function hasStatusAtLeast400(span: Span) {
  return Number(span.attributes["http.response.status_code"] ?? 0) >= 400;
}

function header(trace: Trace, spans: Span[]): Line[] {
  const root = rootInvocation(spans);
  const { start, end } = traceBounds(spans);
  const failed = spans.some((s) => s.status_code === "ERROR");
  const usage = llmUsage(spans);
  if (!root) {
    const first = buildTree(spans)[0].span;
    return [
      { text: `${first.name} · ${ms(end - start)} · ${failed ? "ERROR" : "ok"}`, keep: true },
      { text: `trace ${trace.trace_id} · ${new Date(start).toISOString()} · ${plural(spans.length, "span")}`, keep: true },
    ];
  }
  const a = root.attributes;
  const kind = spanFailureKind(root);
  const res = invocationResources(root);
  const first = [
    root.name,
    triggerText(root),
    a["faas.coldstart"] === "true" ? "cold start" : "warm",
    ms(root.duration_ms),
    root.status_code === "ERROR" ? (kind ? `ERROR (${failureLabel(kind)})` : "ERROR") : failed ? "ok (with failed calls)" : "ok",
  ];
  const memory =
    res.memoryUsedMb !== null && `${res.memoryUsedMb} MB used${res.memoryLimitMb !== null ? ` of ${res.memoryLimitMb} MB` : ""}`;
  const second = [
    `trace ${trace.trace_id}`,
    a["faas.invocation_id"] ? `request ${a["faas.invocation_id"]}` : kind === "init_failed" && "no request",
    root.resource["cloud.region"],
    root.start,
    memory,
    res.billedDurationMs !== null && `billed ${ms(res.billedDurationMs)}`,
    res.initDurationMs !== null && `init ${ms(res.initDurationMs)}`,
    plural(spans.length, "span"),
    usage && usage.calls > 0 && `${plural(usage.calls, "LLM call")} ${usage.inputTokens}→${usage.outputTokens} tok`,
  ].filter(Boolean);
  const lines: Line[] = [
    { text: first.join(" · "), keep: true },
    { text: second.join(" · "), keep: true },
  ];
  const note = missingTraceNote(kind, a["ivy.synthetic"] === "true");
  if (note) lines.push({ text: `(${note})`, keep: true });
  const dropped = droppedSpans(a);
  const collapsed = collapsedCalls(a);
  const volume = [
    dropped && droppedSpansLabel(dropped),
    collapsed && `${formatCount(collapsed)} similar calls collapsed into summary spans (× lines)`,
  ].filter(Boolean);
  if (volume.length) lines.push({ text: volume.join(" · "), keep: true });
  return lines;
}

function errorLines(span: Span, prefix: string, settings: Settings): Line[] {
  const ex = getException(span);
  if (!ex) return [];
  const message = oneLine(ex.message || "", 300);
  const typed = message.includes(ex.type) || (ex.type === "Error" && /^[A-Z]\w*: /.test(message));
  const title = typed ? message : `${ex.type}${message ? `: ${message}` : ""}`;
  const lines: Line[] = [{ text: `${prefix}! ${title}`, keep: true }];
  const frames = (ex.stacktrace ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") && !RUNTIME_FRAME.test(l));
  for (const frame of frames.slice(0, settings.stackFrames)) lines.push({ text: `${prefix}  ${frame}`, keep: true });
  if (frames.length > settings.stackFrames) lines.push({ text: `${prefix}  (+${frames.length - settings.stackFrames} more frames)`, keep: true });
  return lines;
}

function payloadLines(span: Span, prefix: string, settings: Settings): Line[] {
  const wanted =
    settings.payloads === "all" ||
    (settings.payloads === "key" && (isInvocationSpan(span) || span.status_code === "ERROR" || hasStatusAtLeast400(span)));
  if (!wanted) return [];
  const a = span.attributes;
  const lines: Line[] = [];
  const add = (label: string, raw: string | undefined) => {
    const text = trimPayload(raw, settings.payloadChars);
    if (text !== undefined) lines.push({ text: `${prefix}${label}: ${text}` });
  };
  add("req", a["ivy.payload.request"]);
  add("res", a["ivy.payload.response"]);
  if (settings.headers) {
    add("req headers", a["ivy.http.request.headers"]);
    add("res headers", a["ivy.http.response.headers"]);
  }
  return lines;
}

const partText = (p: LlmPart): string => {
  switch (p.type) {
    case "text":
      return p.text;
    case "reasoning":
      return `[reasoning] ${p.text}`;
    case "tool_call":
      return `→ ${p.name}(${p.arguments === undefined ? "" : JSON.stringify(p.arguments)})`;
    case "tool_result":
      return `← ${typeof p.result === "string" ? p.result : JSON.stringify(p.result)}`;
    default:
      return `[${p.label}]`;
  }
};
const messageText = (m: LlmMessage) => m.parts.map(partText).join(" ");

/** Prompt and response of LLM spans: the last input message and the output (normal), or every message (full). */
function llmLines(span: Span, prefix: string, settings: Settings): Line[] {
  const l = describeLlm(span);
  if (!l || settings.payloads === "none") return [];
  const chars = settings.payloadChars;
  const line = (label: string, text: string | undefined): Line[] => (text ? [{ text: `${prefix}${label}: ${oneLine(text, chars)}` }] : []);
  const json = (v: unknown) => (v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v));
  if (l.kind === "tool") return [...line("args", json(l.tool?.arguments)), ...line("result", json(l.tool?.result))];
  if (l.kind === "step" || (l.kind === "operation" && settings.payloads !== "all")) return [];
  const response = line("response", l.output.map(messageText).join(" "));
  if (settings.payloads === "all") return [...l.messages.flatMap((m) => line(m.role, messageText(m))), ...response];
  const last = [...l.messages].reverse().find((m) => m.role !== "system" && m.role !== "assistant");
  return [...line(last?.role === "tool" ? "tool result" : "prompt", last && messageText(last)), ...response];
}

function render(trace: Trace, settings: Settings): Line[] {
  const spans = trace.spans;
  const { start } = traceBounds(spans);
  const offset = (at: number) => `+${ms(at - start)}`;
  const lines: Line[] = [...header(trace, spans), { text: "" }];

  const visit = (node: TraceNode, depth: number) => {
    const { span } = node;
    const failed = span.status_code === "ERROR";
    lines.push({
      text: `${columns(offset(startMs(span)), ms(span.duration_ms))}${indent(depth)}${spanLabel(span)}  ${statusText(span)}`,
      keep: failed,
    });
    const prefix = `${GUTTER}${indent(depth + 1)}`;
    lines.push(...errorLines(span, prefix, settings), ...payloadLines(span, prefix, settings), ...llmLines(span, prefix, settings));

    const logs = logEvents(span).filter((e) => settings.allLogs || /^(warn|error)/i.test(e.attributes["log.severity"] ?? ""));
    const entries: Entry[] = [
      ...node.children.map((child) => ({ node: child, at: startMs(child.span) })),
      ...logs.map((log) => ({ log, at: Date.parse(log.ts) })),
    ].sort((x, y) => x.at - y.at);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (isLog(entry)) {
        const severity = entry.log.attributes["log.severity"] || "info";
        const message = oneLine(entry.log.attributes["log.message"] ?? "", settings.logChars);
        lines.push({ text: `${columns(offset(entry.at), "")}${indent(depth + 1)}log ${severity}: ${message}`, keep: severity === "error" });
        continue;
      }
      const run = settings.collapse ? collapsibleRun(entries, i) : [entry.node];
      if (run.length >= MIN_COLLAPSE) {
        const durations = run.map((n) => n.span.duration_ms);
        const extent = Math.max(...run.map((n) => endMs(n.span))) - startMs(run[0].span);
        lines.push({
          text:
            `${columns(offset(startMs(run[0].span)), ms(extent))}${indent(depth + 1)}${callKey(run[0].span)} ×${run.length}` +
            ` (each ${ms(Math.min(...durations))}–${ms(Math.max(...durations))})  ${statusText(run[0].span)}`,
        });
        i += run.length - 1;
      } else {
        visit(entry.node, depth + 1);
      }
    }
  };

  for (const root of buildTree(spans)) visit(root, 0);
  return lines;
}

/** Consecutive leaf siblings starting at `index` that make the same successful call. */
function collapsibleRun(entries: Entry[], index: number): TraceNode[] {
  const simple = (e: Entry | undefined): e is { node: TraceNode; at: number } =>
    !!e &&
    !isLog(e) &&
    e.node.children.length === 0 &&
    e.node.span.status_code !== "ERROR" &&
    logEvents(e.node.span).length === 0 &&
    !collapsedInfo(e.node.span);
  const first = entries[index];
  if (!simple(first)) return [];
  const key = callKey(first.node.span);
  const run = [first.node];
  for (let j = index + 1; j < entries.length; j++) {
    const next = entries[j];
    if (!simple(next) || callKey(next.node.span) !== key) break;
    run.push(next.node);
  }
  return run;
}

const join = (lines: Line[]) => lines.map((l) => l.text.trimEnd()).join("\n");

/** Drops non-essential lines (keeping header and failures) until the text fits the budget. */
function fit(lines: Line[], maxTokens: number): Line[] {
  const budget = maxTokens * 4;
  let used = lines.filter((l) => l.keep).reduce((n, l) => n + l.text.length + 1, 0);
  const out: Line[] = [];
  let omitted = 0;
  const flush = () => {
    if (omitted) out.push({ text: `${GUTTER}… ${plural(omitted, "line")} omitted (max_tokens)` });
    omitted = 0;
  };
  for (const line of lines) {
    if (line.keep) {
      flush();
      out.push(line);
    } else if (used + line.text.length + 1 + 60 <= budget) {
      flush();
      out.push(line);
      used += line.text.length + 1;
    } else {
      omitted++;
    }
  }
  flush();
  return out;
}

/**
 * Renders a trace (`GET /api/traces/:id` shape) as a compact text tree for LLMs: a header line,
 * then one line per span with offset, duration, indentation for nesting, a service-aware
 * description and status, with errors, trimmed payloads and logs inline.
 */
export function formatTrace(trace: Trace, options: FormatTraceOptions = {}): string {
  if (!trace.spans.length) return `trace ${trace.trace_id}: no spans`;
  const detail = options.detail ?? "normal";
  const maxTokens = options.maxTokens ?? 2000;
  let settings = settingsFor(detail, options.payloadChars);
  let lines = render(trace, settings);
  const over = () => maxTokens > 0 && estimateTokens(join(lines)) > maxTokens;

  while (over() && settings.payloads !== "none" && settings.payloadChars > 80) {
    settings = { ...settings, payloadChars: Math.floor(settings.payloadChars / 2), headers: false };
    lines = render(trace, settings);
  }
  if (over() && detail !== "summary") lines = render(trace, settingsFor("summary"));
  if (over()) lines = fit(lines, maxTokens);
  return join(lines);
}
