import { getException, parsePayload, type Span, type Trace } from "@ivy/spans";
import { estimateTokens, ms, oneLine, plural, signedMs } from "../text/text.js";
import { callKey, statusText, triggerText } from "../trace/label.js";
import { buildTree, flatten, rootInvocation, traceBounds } from "../trace/tree.js";
import { diffJson, showValue } from "./json-diff.js";

export interface CompareOptions {
  /** Names for the two sides (default `A` and `B`). */
  labels?: [string, string];
  /** Approximate output budget in tokens (default 2000); 0 = unlimited. */
  maxTokens?: number;
}

type Pair = { a?: Span; b?: Span };

/** Longest-common-subsequence alignment of the two call sequences by call key. */
function align(a: Span[], b: Span[]): Pair[] {
  const ka = a.map(callKey);
  const kb = b.map(callKey);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ka[i] === kb[j]) pairs.push({ a: a[i++], b: b[j++] });
    else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) pairs.push({ a: a[i++] });
    else pairs.push({ b: b[j++] });
  }
  return pairs;
}

const httpStatus = (s: Span) => s.attributes["http.response.status_code"];

function summary(label: string, trace: Trace): string {
  const root = rootInvocation(trace.spans);
  const { start, end } = traceBounds(trace.spans);
  if (!root) return `${label}: trace ${trace.trace_id} · ${ms(end - start)} · ${trace.spans.some((s) => s.status_code === "ERROR") ? "ERROR" : "ok"}`;
  const cold = root.attributes["faas.coldstart"] === "true" ? "cold start" : "warm";
  return `${label}: ${root.name} · ${triggerText(root)} · ${cold} · ${ms(root.duration_ms)} · ${statusText(root)} · trace ${trace.trace_id} · ${root.start}`;
}

function firstError(trace: Trace): string | undefined {
  const failed = trace.spans.find((s) => s.events.some((e) => e.name === "exception")) ?? trace.spans.find((s) => s.status_code === "ERROR");
  const ex = failed && getException(failed);
  if (!ex) return undefined;
  const message = oneLine(ex.message, 200);
  return message.startsWith(ex.type) ? message : `${ex.type}: ${message}`;
}

function payloadDiffLines(a: Span, b: Span, valuesToo: boolean, labels: [string, string], prefix: string): string[] {
  const lines: string[] = [];
  for (const [name, attr] of [["req", "ivy.payload.request"], ["res", "ivy.payload.response"]] as const) {
    const x = parsePayload(a.attributes[attr]);
    const y = parsePayload(b.attributes[attr]);
    for (const d of diffJson(x, y, valuesToo, 4)) {
      const path = d.path ? `${name}.${d.path}` : name;
      lines.push(`${prefix}${path}: ${labels[0]} ${showValue(d.a)} | ${labels[1]} ${showValue(d.b)}`);
    }
  }
  return lines;
}

function significantlySlower(x: number, y: number) {
  const [lo, hi] = x < y ? [x, y] : [y, x];
  return hi - lo > 20 && hi > lo * 2;
}

/**
 * Compares two traces (typically a failing invocation and a recent successful one of the same
 * function): top-level differences, the error, then the calls aligned side by side with timing,
 * status and payload differences. Calls only one side made are marked.
 */
export function compareTraces(a: Trace, b: Trace, options: CompareOptions = {}): string {
  const labels = options.labels ?? ["A", "B"];
  const [la, lb] = labels;
  const out: string[] = [summary(la, a), summary(lb, b), ""];

  const ra = rootInvocation(a.spans);
  const rb = rootInvocation(b.spans);
  const diffs: string[] = [];
  if (ra && rb) {
    if (ra.name !== rb.name) diffs.push(`function: ${ra.name} vs ${rb.name}`);
    if (ra.status_code !== rb.status_code) diffs.push(`status: ${statusText(ra)} vs ${statusText(rb)}`);
    if (httpStatus(ra) !== httpStatus(rb)) diffs.push(`http status: ${httpStatus(ra) ?? "-"} vs ${httpStatus(rb) ?? "-"}`);
    diffs.push(`duration: ${ms(ra.duration_ms)} vs ${ms(rb.duration_ms)} (${signedMs(ra.duration_ms - rb.duration_ms)})`);
    if (ra.attributes["faas.coldstart"] !== rb.attributes["faas.coldstart"]) {
      diffs.push(`cold start: ${ra.attributes["faas.coldstart"] ?? "false"} vs ${rb.attributes["faas.coldstart"] ?? "false"}`);
    }
  }
  if (diffs.length) out.push("Differences:", ...diffs.map((d) => `  ${d}`));
  for (const [label, trace] of [[la, a], [lb, b]] as const) {
    const error = firstError(trace);
    if (error) out.push(`  error in ${label}: ${error}`);
  }
  if (ra && rb) {
    const invocationDiffs = payloadDiffLines(ra, rb, false, labels, "    ");
    if (invocationDiffs.length) out.push("  invocation payload shape:", ...invocationDiffs);
  }

  const calls = (trace: Trace, root: Span | undefined) =>
    flatten(buildTree(trace.spans))
      .map((e) => e.span)
      .filter((s) => s !== root);
  const pairs = align(calls(a, ra), calls(b, rb));
  const onlyA = pairs.filter((p) => p.a && !p.b).length;
  const onlyB = pairs.filter((p) => p.b && !p.a).length;

  out.push("", `Calls (${la} vs ${lb}; ${onlyA} only in ${la}, ${onlyB} only in ${lb}):`);
  if (!pairs.length) out.push("  (no calls on either side)");
  for (const { a: x, b: y } of pairs) {
    if (x && y) {
      const notes: string[] = [];
      if (x.status_code !== y.status_code) notes.push(`status ${statusText(x)} vs ${statusText(y)}`);
      if (httpStatus(x) !== httpStatus(y)) notes.push(`http ${httpStatus(x) ?? "-"} vs ${httpStatus(y) ?? "-"}`);
      if (significantlySlower(x.duration_ms, y.duration_ms)) notes.push(x.duration_ms > y.duration_ms ? `slower in ${la}` : `slower in ${lb}`);
      const changed = notes.length > 0;
      const payload = payloadDiffLines(x, y, changed, labels, "      ");
      out.push(`  ${changed || payload.length ? "~" : "="} ${callKey(x)}  ${ms(x.duration_ms)} vs ${ms(y.duration_ms)}${notes.length ? `  ${notes.join(", ")}` : ""}`);
      out.push(...payload);
    } else {
      const span = (x ?? y)!;
      out.push(`  ${x ? `+ only in ${la}` : `- only in ${lb}`}: ${callKey(span)}  ${ms(span.duration_ms)} ${statusText(span)}`);
    }
  }

  const text = out.join("\n");
  const maxTokens = options.maxTokens ?? 2000;
  if (maxTokens > 0 && estimateTokens(text) > maxTokens) {
    const cut = text.slice(0, maxTokens * 4);
    return `${cut.slice(0, cut.lastIndexOf("\n"))}\n… ${plural(text.slice(cut.lastIndexOf("\n")).split("\n").length - 1, "line")} omitted (max_tokens)`;
  }
  return text;
}
