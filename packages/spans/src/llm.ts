import type { Span } from "./types.js";

/**
 * Normalizes LLM spans from the instrumentations Ivy knows into one shape (see
 * docs/implementation/span-conventions.md, "LLM spans"):
 * - Vercel AI SDK (`ai.*`: AI SDK 3–6 and `LegacyOpenTelemetry` in 7),
 * - OpenTelemetry GenAI semantic conventions (`gen_ai.*`: AI SDK 7's `OpenTelemetry`, OpenAI/Anthropic/
 *   Bedrock/LangChain instrumentations), including the older indexed (`gen_ai.prompt.0.content`) and
 *   event-based message formats,
 * - OpenInference (`llm.*`, `openinference.span.kind`).
 */

export type LlmKind = "operation" | "step" | "call" | "tool" | "embedding";

export type LlmPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id?: string; name: string; arguments?: unknown }
  | { type: "tool_result"; id?: string; name?: string; result: unknown }
  | { type: "file"; label: string };

export interface LlmMessage {
  role: string;
  parts: LlmPart[];
}

export interface LlmToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
  result?: unknown;
}

export interface LlmSetting {
  label: string;
  value: string;
}

export interface LlmSpan {
  kind: LlmKind;
  /** Short operation name: `generateText`, `streamText`, `chat`, `invoke_agent`, `tool`, `step 2`, `embed`, … */
  operation: string;
  provider?: string;
  providerLabel?: string;
  model?: string;
  responseModel?: string;
  functionId?: string;
  streaming: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** Time to first token/chunk of a streamed response. */
  ttftMs?: number;
  finishReason?: string;
  settings: LlmSetting[];
  /** Input conversation, system instructions first. */
  messages: LlmMessage[];
  /** The model's response. */
  output: LlmMessage[];
  /** Tool spans: the call with arguments and result. */
  tool?: LlmToolCall;
  /** Tool definitions offered to the model. */
  tools: { name: string; description?: string }[];
}

type Attrs = Record<string, string>;

const TRUNCATION_MARKER = /…\[truncated \d+ bytes\]$/;

function json(value: string | undefined): unknown {
  if (value === undefined || value === "") return undefined;
  try {
    return JSON.parse(value.replace(TRUNCATION_MARKER, ""));
  } catch {
    return value;
  }
}

/** Parses a string that holds JSON (tool arguments are often double-encoded), else returns it as is. */
function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

function num(...values: (string | undefined)[]): number | undefined {
  for (const v of values) {
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function first(a: Attrs, ...keys: string[]): string | undefined {
  for (const k of keys) if (a[k] !== undefined && a[k] !== "") return a[k];
  return undefined;
}

function stringList(value: string | undefined): string[] {
  const v = json(value);
  if (Array.isArray(v)) return v.map(String);
  return typeof v === "string" && v ? [v] : [];
}

const PROVIDERS: [RegExp, string, string][] = [
  [/azure/, "azure-openai", "Azure OpenAI"],
  [/bedrock/, "bedrock", "Amazon Bedrock"],
  [/vertex/, "vertex", "Vertex AI"],
  [/openrouter/, "openrouter", "OpenRouter"],
  [/openai/, "openai", "OpenAI"],
  [/anthropic/, "anthropic", "Anthropic"],
  [/google|gemini/, "google", "Google Gemini"],
  [/mistral/, "mistral", "Mistral"],
  [/groq/, "groq", "Groq"],
  [/cohere/, "cohere", "Cohere"],
  [/^x_?ai\b|^xai/, "xai", "xAI"],
  [/deepseek/, "deepseek", "DeepSeek"],
  [/perplexity/, "perplexity", "Perplexity"],
  [/ollama/, "ollama", "Ollama"],
  [/together/, "together", "Together AI"],
  [/fireworks/, "fireworks", "Fireworks"],
  [/cerebras/, "cerebras", "Cerebras"],
  [/watsonx/, "watsonx", "IBM watsonx"],
  [/gateway/, "gateway", "AI Gateway"],
];

const MODEL_PROVIDERS: [RegExp, string][] = [
  [/^(gpt-|o\d|text-embedding-|chatgpt)/, "openai"],
  [/^claude/, "anthropic"],
  [/^gemini|^gemma/, "google"],
  [/^(mistral|mixtral|codestral)/, "mistral"],
  [/^grok/, "xai"],
];

/** Provider ID and label from `gen_ai.provider.name`, `gen_ai.system`, `ai.model.provider` (`openai.chat`), …; falls back to the model name. */
export function normalizeProvider(raw: string | undefined, model?: string): { id: string; label: string } | undefined {
  const r = raw?.toLowerCase().trim();
  if (r) {
    const hit = PROVIDERS.find(([re]) => re.test(r));
    if (hit) return { id: hit[1], label: hit[2] };
    const id = r.split(".")[0];
    return { id, label: raw!.split(".")[0] };
  }
  const m = model?.toLowerCase();
  const byModel = m && MODEL_PROVIDERS.find(([re]) => re.test(m));
  if (byModel) return normalizeProvider(byModel[1]);
  return undefined;
}

// ---- message parts -------------------------------------------------------------------------

/** One content part from the AI SDK (`tool-call`, `tool-result`, …) or GenAI (`tool_call`, `tool_call_response`, …) formats. */
function toPart(p: unknown): LlmPart | undefined {
  if (typeof p === "string") return { type: "text", text: p };
  if (!isRecord(p)) return undefined;
  const type = String(p.type ?? "text");
  switch (type) {
    case "text":
      return { type: "text", text: str(p.text) ?? str(p.content) ?? "" };
    case "reasoning":
    case "thinking":
      return { type: "reasoning", text: str(p.text) ?? str(p.content) ?? str(p.thinking) ?? "" };
    case "tool-call":
    case "tool_call":
    case "tool_use":
    case "function_call":
      return {
        type: "tool_call",
        id: str(p.toolCallId) ?? str(p.id),
        name: str(p.toolName) ?? str(p.name) ?? "tool",
        arguments: maybeJson(p.input ?? p.args ?? p.arguments),
      };
    case "tool-result":
    case "tool_call_response":
    case "tool_result": {
      const output = p.output ?? p.result ?? p.response ?? p.content;
      const value = isRecord(output) && "value" in output && "type" in output ? output.value : output;
      return { type: "tool_result", id: str(p.toolCallId) ?? str(p.id) ?? str(p.tool_use_id), name: str(p.toolName), result: maybeJson(value) };
    }
    case "image":
    case "file":
    case "blob":
    case "uri":
    case "image_url": {
      const media = str(p.mediaType) ?? str(p.mimeType) ?? str(p.mime_type) ?? str(p.modality) ?? type;
      const where = str(p.uri) ?? (typeof p.image === "string" && p.image.startsWith("http") ? p.image : undefined);
      return { type: "file", label: where ? `${media} ${where}` : media };
    }
    default:
      return { type: "text", text: str(p.text) ?? str(p.content) ?? JSON.stringify(p) };
  }
}

function toParts(content: unknown): LlmPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.map(toPart).filter((p): p is LlmPart => !!p);
  return [toPart(content)].filter((p): p is LlmPart => !!p);
}

/** Chat messages in the AI SDK (`{role, content}`), GenAI (`{role, parts}`) or OpenAI (`{role, content, tool_calls}`) shapes. */
function toMessages(value: unknown): LlmMessage[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [{ role: "prompt", parts: [{ type: "text", text: value }] }];
  if (!Array.isArray(value)) return isRecord(value) ? toMessages([value]) : [];
  return value.flatMap((m): LlmMessage[] => {
    if (typeof m === "string") return [{ role: "user", parts: [{ type: "text", text: m }] }];
    if (!isRecord(m)) return [];
    const parts = toParts(m.parts ?? m.content);
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const c of calls) {
      if (!isRecord(c)) continue;
      const fn = isRecord(c.function) ? c.function : c;
      parts.push({ type: "tool_call", id: str(c.id), name: str(fn.name) ?? "tool", arguments: maybeJson(fn.arguments) });
    }
    const role = str(m.role) ?? "user";
    if (role === "tool" && parts.length && parts.every((p) => p.type === "text")) {
      return [{ role, parts: [{ type: "tool_result", id: str(m.tool_call_id) ?? str(m.id), result: maybeJson((parts[0] as { text: string }).text) }] }];
    }
    return [{ role, parts }];
  });
}

/** Indexed attributes: `gen_ai.prompt.0.role`, `llm.input_messages.0.message.content`, … */
function indexedMessages(a: Attrs, prefix: string, inner = ""): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (let i = 0; i < 500; i++) {
    const base = `${prefix}.${i}.${inner}`;
    const role = a[`${base}role`];
    const content = a[`${base}content`];
    const toolCalls: LlmPart[] = [];
    for (let j = 0; j < 50; j++) {
      const name = a[`${base}tool_calls.${j}.name`] ?? a[`${base}tool_calls.${j}.tool_call.function.name`];
      if (name === undefined) break;
      toolCalls.push({
        type: "tool_call",
        id: a[`${base}tool_calls.${j}.id`] ?? a[`${base}tool_calls.${j}.tool_call.id`],
        name,
        arguments: maybeJson(a[`${base}tool_calls.${j}.arguments`] ?? a[`${base}tool_calls.${j}.tool_call.function.arguments`]),
      });
    }
    if (role === undefined && content === undefined && !toolCalls.length) break;
    const parsed = maybeJson(content);
    const parts = Array.isArray(parsed) ? toParts(parsed) : content ? [{ type: "text" as const, text: content }] : [];
    out.push({ role: role ?? "user", parts: [...parts, ...toolCalls] });
  }
  return out;
}

/** Older GenAI conventions record messages as span events (`gen_ai.user.message`, `gen_ai.choice`, `gen_ai.content.prompt`). */
function eventMessages(span: Span): { input: LlmMessage[]; output: LlmMessage[] } {
  const input: LlmMessage[] = [];
  const output: LlmMessage[] = [];
  for (const e of span.events) {
    const ea = e.attributes;
    const role = /^gen_ai\.(system|user|assistant|tool)\.message$/.exec(e.name)?.[1];
    if (role) {
      const body = json(ea["gen_ai.event.content"] ?? ea.body);
      const content = ea.content ?? (isRecord(body) ? body.content : undefined);
      const msg = toMessages([{ role, content: maybeJson(content) ?? "", tool_calls: maybeJson(ea.tool_calls) ?? (isRecord(body) ? body.tool_calls : undefined), tool_call_id: ea.id }]);
      input.push(...msg);
    } else if (e.name === "gen_ai.choice") {
      const message = json(ea.message) ?? (isRecord(json(ea.body)) ? (json(ea.body) as Record<string, unknown>).message : undefined);
      output.push(...toMessages([{ role: "assistant", ...(isRecord(message) ? message : { content: ea.content ?? "" }) }]));
    } else if (e.name === "gen_ai.content.prompt") {
      input.push(...toMessages(json(ea["gen_ai.prompt"])));
    } else if (e.name === "gen_ai.content.completion") {
      output.push(...toMessages(json(ea["gen_ai.completion"])));
    }
  }
  return { input, output };
}

// ---- detection -----------------------------------------------------------------------------

const AI_SDK_OPERATIONS = /^ai\.(generateText|streamText|generateObject|streamObject|embed|embedMany|rerank|generateSpeech|transcribe|streamTranscribe|generateImage)$/;

function classify(span: Span): { kind: LlmKind; operation: string; source: "ai" | "gen_ai" | "openinference" } | undefined {
  const a = span.attributes;
  const opId = a["ai.operationId"] ?? (span.name.startsWith("ai.") ? span.name : undefined);
  if (opId) {
    if (opId === "ai.toolCall") return { kind: "tool", operation: "tool", source: "ai" };
    if (/\.do(Generate|Stream)$/.test(opId)) return { kind: "call", operation: opId.split(".")[2], source: "ai" };
    if (/\.doEmbed$/.test(opId)) return { kind: "embedding", operation: opId.split(".")[1], source: "ai" };
    if (AI_SDK_OPERATIONS.test(opId)) {
      const op = opId.slice(3);
      return { kind: op.startsWith("embed") ? "embedding" : "operation", operation: op, source: "ai" };
    }
  }

  const genOp = a["gen_ai.operation.name"];
  if (genOp) {
    if (genOp === "execute_tool") return { kind: "tool", operation: "tool", source: "gen_ai" };
    if (genOp === "agent_step") return { kind: "step", operation: span.name, source: "gen_ai" };
    if (genOp === "invoke_agent" || genOp === "create_agent") return { kind: "operation", operation: genOp, source: "gen_ai" };
    if (genOp === "embeddings") return { kind: "embedding", operation: "embeddings", source: "gen_ai" };
    return { kind: "call", operation: genOp, source: "gen_ai" };
  }

  const oi = a["openinference.span.kind"]?.toUpperCase();
  if (oi === "LLM") return { kind: "call", operation: "llm", source: "openinference" };
  if (oi === "TOOL") return { kind: "tool", operation: "tool", source: "openinference" };
  if (oi === "EMBEDDING") return { kind: "embedding", operation: "embedding", source: "openinference" };
  if (oi === "AGENT") return { kind: "operation", operation: "agent", source: "openinference" };

  if (a["traceloop.span.kind"] === "tool") return { kind: "tool", operation: "tool", source: "gen_ai" };
  if (a["gen_ai.system"] || a["gen_ai.provider.name"] || a["gen_ai.request.model"] || a["llm.request.type"]) {
    return { kind: "call", operation: a["llm.request.type"] ?? "chat", source: "gen_ai" };
  }
  return undefined;
}

// ---- describers per source -----------------------------------------------------------------

const SETTINGS: [string, string[]][] = [
  ["Temperature", ["gen_ai.request.temperature", "ai.settings.temperature"]],
  ["Max tokens", ["gen_ai.request.max_tokens", "ai.settings.maxOutputTokens", "ai.settings.maxTokens"]],
  ["Top P", ["gen_ai.request.top_p", "ai.settings.topP"]],
  ["Top K", ["gen_ai.request.top_k", "ai.settings.topK"]],
  ["Frequency penalty", ["gen_ai.request.frequency_penalty", "ai.settings.frequencyPenalty"]],
  ["Presence penalty", ["gen_ai.request.presence_penalty", "ai.settings.presencePenalty"]],
  ["Stop sequences", ["gen_ai.request.stop_sequences", "ai.settings.stopSequences"]],
  ["Seed", ["gen_ai.request.seed", "ai.settings.seed"]],
  ["Max retries", ["ai.settings.maxRetries"]],
  ["Tool choice", ["ai.prompt.toolChoice"]],
];

function settings(a: Attrs): LlmSetting[] {
  const out: LlmSetting[] = [];
  for (const [label, keys] of SETTINGS) {
    const v = first(a, ...keys);
    if (v === undefined) continue;
    const parsed = json(v);
    out.push({ label, value: Array.isArray(parsed) ? parsed.join(", ") : isRecord(parsed) ? (str(parsed.type) ?? v) : v });
  }
  const params = json(a["llm.invocation_parameters"]);
  if (isRecord(params)) {
    for (const [k, v] of Object.entries(params)) if (["string", "number", "boolean"].includes(typeof v)) out.push({ label: k, value: String(v) });
  }
  return out;
}

function toolDefinitions(a: Attrs): LlmSpan["tools"] {
  const raw = a["gen_ai.tool.definitions"] ? json(a["gen_ai.tool.definitions"]) : stringList(a["ai.prompt.tools"]).map((t) => maybeJson(t));
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    if (!isRecord(t)) return [];
    const fn = isRecord(t.function) ? t.function : t;
    const name = str(fn.name);
    return name ? [{ name, description: str(fn.description) }] : [];
  });
}

/** The AI SDK's `ai.prompt`: `{ system?, prompt?, messages? }`. */
function aiPrompt(value: string | undefined): LlmMessage[] {
  const p = json(value);
  if (!isRecord(p)) return p === undefined ? [] : toMessages(p);
  const out: LlmMessage[] = [];
  if (typeof p.system === "string") out.push({ role: "system", parts: [{ type: "text", text: p.system }] });
  if (typeof p.prompt === "string") out.push({ role: "user", parts: [{ type: "text", text: p.prompt }] });
  else if (Array.isArray(p.prompt)) out.push(...toMessages(p.prompt));
  if (Array.isArray(p.messages)) out.push(...toMessages(p.messages));
  return out;
}

function systemInstructions(value: string | undefined): LlmMessage[] {
  if (!value) return [];
  const v = json(value);
  const parts = toParts(Array.isArray(v) ? v : typeof v === "string" ? v : [v]);
  return parts.length ? [{ role: "system", parts }] : [];
}

function aiSdkOutput(a: Attrs): LlmMessage[] {
  const parts: LlmPart[] = [];
  const text = a["ai.response.text"];
  if (text) parts.push({ type: "text", text });
  const object = a["ai.response.object"];
  if (object) parts.push({ type: "text", text: object });
  const calls = json(a["ai.response.toolCalls"]);
  if (Array.isArray(calls)) {
    for (const c of calls) {
      if (!isRecord(c)) continue;
      parts.push({ type: "tool_call", id: str(c.toolCallId), name: str(c.toolName) ?? "tool", arguments: maybeJson(c.input ?? c.args) });
    }
  }
  return parts.length ? [{ role: "assistant", parts }] : [];
}

function ttft(span: Span): number | undefined {
  const a = span.attributes;
  const ms = num(a["ai.response.msToFirstChunk"], a["ai.stream.msToFirstChunk"]);
  if (ms !== undefined) return ms;
  const seconds = num(a["gen_ai.client.operation.time_to_first_chunk"], a["gen_ai.response.time_to_first_chunk"], a["gen_ai.server.time_to_first_token"]);
  if (seconds !== undefined) return seconds * 1000;
  const event = span.events.find((e) => e.name === "ai.stream.firstChunk");
  return event ? num(event.attributes["ai.response.msToFirstChunk"], event.attributes["ai.stream.msToFirstChunk"]) : undefined;
}

function toolCall(a: Attrs, source: string): LlmToolCall {
  if (source === "ai") {
    return {
      id: a["ai.toolCall.id"],
      name: a["ai.toolCall.name"] ?? "tool",
      arguments: maybeJson(json(first(a, "ai.toolCall.args", "ai.toolCall.input"))),
      result: maybeJson(json(first(a, "ai.toolCall.result", "ai.toolCall.output"))),
    };
  }
  return {
    id: first(a, "gen_ai.tool.call.id", "tool_call.id"),
    name: first(a, "gen_ai.tool.name", "tool.name", "traceloop.entity.name") ?? "tool",
    arguments: maybeJson(json(first(a, "gen_ai.tool.call.arguments", "tool.parameters", "input.value", "traceloop.entity.input"))),
    result: maybeJson(json(first(a, "gen_ai.tool.call.result", "output.value", "traceloop.entity.output"))),
  };
}

const memo = new WeakMap<Span, LlmSpan | null>();

/** The LLM view of a span, or undefined when it isn't an LLM, agent, embedding or tool-call span. */
export function describeLlm(span: Span): LlmSpan | undefined {
  const cached = memo.get(span);
  if (cached !== undefined) return cached ?? undefined;
  const result = build(span);
  memo.set(span, result ?? null);
  return result;
}

function build(span: Span): LlmSpan | undefined {
  const c = classify(span);
  if (!c) return undefined;
  const a = span.attributes;
  const model = first(a, "ai.model.id", "gen_ai.request.model", "llm.model_name", "gen_ai.response.model", "ai.response.model");
  const provider = normalizeProvider(first(a, "gen_ai.provider.name", "ai.model.provider", "gen_ai.system", "llm.provider", "llm.system"), model);
  const responseModel = first(a, "gen_ai.response.model", "ai.response.model", "llm.model_name");

  let messages: LlmMessage[] = [];
  let output: LlmMessage[] = [];
  if (c.source === "ai") {
    messages = a["ai.prompt.messages"] ? toMessages(json(a["ai.prompt.messages"])) : aiPrompt(a["ai.prompt"]);
    output = aiSdkOutput(a);
    if (a["ai.value"] || a["ai.values"]) messages = toMessages(stringList(a["ai.values"] ?? a["ai.value"]));
  } else if (c.source === "openinference") {
    messages = indexedMessages(a, "llm.input_messages", "message.");
    output = indexedMessages(a, "llm.output_messages", "message.");
  } else {
    messages = [...systemInstructions(a["gen_ai.system_instructions"]), ...toMessages(json(a["gen_ai.input.messages"]))];
    output = toMessages(json(a["gen_ai.output.messages"]));
    if (!messages.length) messages = indexedMessages(a, "gen_ai.prompt");
    if (!output.length) output = indexedMessages(a, "gen_ai.completion").map((m) => ({ ...m, role: m.role === "user" ? "assistant" : m.role }));
    if (!messages.length && !output.length) ({ input: messages, output } = eventMessages(span));
  }

  const finishReasons = [
    ...stringList(a["gen_ai.response.finish_reasons"]),
    ...(a["ai.response.finishReason"] ?? a["ai.finishReason"] ? [a["ai.response.finishReason"] ?? a["ai.finishReason"]] : []),
    ...(a["gen_ai.completion.0.finish_reason"] ? [a["gen_ai.completion.0.finish_reason"]] : []),
  ];

  const inputTokens = num(a["gen_ai.usage.input_tokens"], a["ai.usage.inputTokens"], a["ai.usage.promptTokens"], a["gen_ai.usage.prompt_tokens"], a["llm.token_count.prompt"], a["ai.usage.tokens"]);
  const outputTokens = num(a["gen_ai.usage.output_tokens"], a["ai.usage.outputTokens"], a["ai.usage.completionTokens"], a["gen_ai.usage.completion_tokens"], a["llm.token_count.completion"]);
  const time = ttft(span);

  return {
    kind: c.kind,
    operation: c.operation,
    provider: provider?.id,
    providerLabel: provider?.label,
    model,
    responseModel: responseModel !== model ? responseModel : undefined,
    functionId: first(a, "ai.telemetry.functionId", "gen_ai.agent.name"),
    streaming: /stream/i.test(c.operation) || time !== undefined || a["gen_ai.request.stream"] === "true",
    inputTokens,
    outputTokens,
    totalTokens: num(a["ai.usage.totalTokens"], a["llm.usage.total_tokens"], a["llm.token_count.total"]) ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined),
    cachedInputTokens: num(a["gen_ai.usage.cache_read.input_tokens"], a["ai.usage.cachedInputTokens"], a["gen_ai.usage.cache_read_input_tokens"]) || undefined,
    ttftMs: time,
    finishReason: finishReasons.length ? [...new Set(finishReasons)].join(", ") : undefined,
    settings: settings(a),
    messages,
    output,
    tool: c.kind === "tool" ? toolCall(a, c.source) : undefined,
    tools: toolDefinitions(a),
  };
}

export const isLlmSpan = (span: Span) => describeLlm(span) !== undefined;

const countTokens = (l: LlmSpan | undefined) => !!l && (l.inputTokens !== undefined || l.outputTokens !== undefined);

export interface LlmUsageRow {
  provider?: string;
  providerLabel?: string;
  model?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byModel: LlmUsageRow[];
}

/**
 * Token totals of a set of spans. Operations repeat the usage of their model calls, so only spans with
 * usage and no descendant with usage are counted.
 */
export function llmUsage(spans: Span[]): LlmUsage | undefined {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const withUsage = spans.filter((s) => countTokens(describeLlm(s)));
  if (!spans.some((s) => describeLlm(s))) return undefined;
  const hasUsageBelow = new Set<string>();
  for (const s of withUsage) {
    let parent = byId.get(s.parent_span_id);
    while (parent && !hasUsageBelow.has(parent.span_id)) {
      hasUsageBelow.add(parent.span_id);
      parent = byId.get(parent.parent_span_id);
    }
  }
  const rows = new Map<string, LlmUsageRow>();
  const usage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0, byModel: [] };
  for (const s of withUsage) {
    if (hasUsageBelow.has(s.span_id)) continue;
    const l = describeLlm(s)!;
    const key = `${l.provider}|${l.model}`;
    const row = rows.get(key) ?? { provider: l.provider, providerLabel: l.providerLabel, model: l.model, calls: 0, inputTokens: 0, outputTokens: 0 };
    row.calls += 1;
    row.inputTokens += l.inputTokens ?? 0;
    row.outputTokens += l.outputTokens ?? 0;
    rows.set(key, row);
    usage.calls += 1;
    usage.inputTokens += l.inputTokens ?? 0;
    usage.outputTokens += l.outputTokens ?? 0;
  }
  usage.byModel = [...rows.values()];
  return usage;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
export const formatTokens = (n: number) => n.toLocaleString("en");

/** `812 → 164 tokens · ttft 320ms`, the summary shown after an LLM span's title. */
export function llmNote(l: LlmSpan): string | undefined {
  const parts: string[] = [];
  if (l.kind === "tool") return undefined;
  if (l.inputTokens !== undefined || l.outputTokens !== undefined) {
    parts.push(l.outputTokens !== undefined && l.kind !== "embedding" ? `${formatTokens(l.inputTokens ?? 0)} → ${formatTokens(l.outputTokens)} tokens` : `${formatTokens(l.inputTokens ?? 0)} tokens`);
  }
  if (l.ttftMs !== undefined) parts.push(`ttft ${fmtMs(l.ttftMs)}`);
  if (l.finishReason && !/^(stop|end_turn|tool-calls|tool_calls|tool_call|tool_use)$/.test(l.finishReason)) parts.push(l.finishReason);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Tool names the model asked for in its response, for one-line summaries. */
export function requestedTools(l: LlmSpan): string[] {
  return l.output.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_call" ? [p.name] : [])));
}
