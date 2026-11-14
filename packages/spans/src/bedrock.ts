import type { LlmMessage, LlmPart, LlmSetting, LlmSpan } from "./llm.js";
import { toMessages, toParts } from "./llm.js";
import type { Span } from "./types.js";

/**
 * Direct Amazon Bedrock Runtime calls (AWS SDK `BedrockRuntimeClient`, or the plain HTTP request when the
 * SDK copy wasn't patched) as LLM calls: the request and response bodies in `ivy.payload.*` are parsed
 * per provider family (see docs/implementation/llm-spans.md, "Amazon Bedrock").
 */

const PATH_OPERATIONS: Record<string, string> = {
  invoke: "InvokeModel",
  "invoke-with-response-stream": "InvokeModelWithResponseStream",
  converse: "Converse",
  "converse-stream": "ConverseStream",
};
const OPERATIONS = new Set(Object.values(PATH_OPERATIONS));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const get = (v: unknown, ...path: (string | number)[]): unknown => {
  let cur = v;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === "number") cur = cur[key];
    else if (isRecord(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
};

function num(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const TRUNCATION_MARKER = /…\[truncated \d+ bytes\]$/;

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.replace(TRUNCATION_MARKER, "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

const isBedrockService = (service: string | undefined) => {
  const s = service?.toLowerCase().replace(/[^a-z]/g, "");
  return s === "bedrockruntime" || s === "bedrock";
};

/** `/model/{modelId}/invoke` (and `converse`, the streaming variants) of a Bedrock Runtime URL. */
export function bedrockPath(url: string | undefined): { operation: string; modelId: string } | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/bedrock-runtime[\w.-]*\.amazonaws\.com(?::\d+)?\/model\/([^/?#]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)(?:[?#]|$)/i.exec(url);
  if (!m) return undefined;
  let modelId = m[1];
  try {
    modelId = decodeURIComponent(modelId);
  } catch {
    // keep as is
  }
  return { operation: PATH_OPERATIONS[m[2].toLowerCase()], modelId };
}

/** `eu.anthropic.claude-haiku-5-5-20261001-v1:0` (or an inference profile ARN) → `claude-haiku-5-5`. */
export function shortModelName(modelId: string): string {
  let s = modelId.slice(modelId.lastIndexOf("/") + 1);
  s = s.replace(/^(us|eu|apac|ap|global|us-gov|jp|au|ca)\./, "");
  s = s.replace(/^(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|writer|twelvelabs|stability|luma)\./, "");
  s = s.replace(/-v\d+(:\d+)?$/, "").replace(/:\d+(k)?$/, "");
  s = s.replace(/-\d{8}$/, "");
  return s || modelId;
}

const VENDORS: [RegExp, string][] = [
  [/anthropic|claude/, "Anthropic"],
  [/amazon|nova|titan/, "Amazon"],
  [/meta|llama/, "Meta"],
  [/mistral|mixtral|pixtral/, "Mistral"],
  [/cohere|command/, "Cohere"],
  [/ai21|jamba/, "AI21"],
  [/deepseek/, "DeepSeek"],
  [/openai|gpt-oss/, "OpenAI"],
  [/qwen/, "Qwen"],
  [/writer|palmyra/, "Writer"],
];

function vendorOf(modelId: string | undefined, req: unknown, res: unknown): string | undefined {
  const id = modelId?.toLowerCase() ?? "";
  const hit = id && !id.startsWith("arn:aws:bedrock") ? VENDORS.find(([re]) => re.test(id)) : undefined;
  if (hit) return hit[1];
  if (isRecord(req) && (req.anthropic_version || isRecord(req.thinking))) return "Anthropic";
  if (str(get(res, "model"))?.startsWith("claude")) return "Anthropic";
  if (isRecord(req) && req.schemaVersion === "messages-v1") return "Amazon";
  const fromArn = id ? VENDORS.find(([re]) => re.test(id.slice(id.lastIndexOf("/") + 1))) : undefined;
  return fromArn?.[1];
}

// ---- content -------------------------------------------------------------------------------

/** One Converse API / Amazon Nova content block (`{text}`, `{toolUse}`, `{toolResult}`, …). */
function converseBlock(b: unknown): LlmPart | undefined {
  if (!isRecord(b)) return typeof b === "string" ? { type: "text", text: b } : undefined;
  if (typeof b.text === "string") return { type: "text", text: b.text };
  if (isRecord(b.toolUse)) {
    const t = b.toolUse;
    return { type: "tool_call", id: str(t.toolUseId), name: str(t.name) ?? "tool", arguments: parse(t.input) };
  }
  if (isRecord(b.toolResult)) {
    const t = b.toolResult;
    const items = arr(t.content).map((c) => (isRecord(c) ? (c.json ?? c.text ?? c) : c));
    return { type: "tool_result", id: str(t.toolUseId), result: items.length === 1 ? parse(items[0]) : items };
  }
  if (isRecord(b.reasoningContent)) {
    return { type: "reasoning", text: str(get(b.reasoningContent, "reasoningText", "text")) ?? (b.reasoningContent.redactedContent ? "[redacted reasoning]" : "") };
  }
  for (const kind of ["image", "document", "video"]) {
    const media = b[kind];
    if (isRecord(media)) return { type: "file", label: [`${kind}/${str(media.format) ?? "?"}`, str(media.name)].filter(Boolean).join(" ") };
  }
  if (isRecord(b.guardContent)) return { type: "text", text: str(get(b.guardContent, "text", "text")) ?? "" };
  if (isRecord(b.cachePoint)) return undefined;
  return { type: "text", text: JSON.stringify(b) };
}

const isConverseContent = (content: unknown) => Array.isArray(content) && content.some((b) => isRecord(b) && !("type" in b));

function contentParts(content: unknown): LlmPart[] {
  if (isConverseContent(content)) return arr(content).map(converseBlock).filter((p): p is LlmPart => !!p);
  return toParts(content);
}

function messagesOf(list: unknown): LlmMessage[] {
  return arr(list).flatMap((m): LlmMessage[] => {
    if (isRecord(m) && isConverseContent(m.content)) return [{ role: str(m.role) ?? "user", parts: contentParts(m.content) }];
    return toMessages([m]);
  });
}

function systemOf(system: unknown): LlmMessage[] {
  if (system === undefined || system === null || system === "") return [];
  const parts = typeof system === "string" ? [{ type: "text" as const, text: system }] : contentParts(Array.isArray(system) ? system : [system]);
  return parts.length ? [{ role: "system", parts }] : [];
}

const COHERE_ROLES: Record<string, string> = { USER: "user", CHATBOT: "assistant", SYSTEM: "system", TOOL: "tool" };

function inputMessages(body: unknown): LlmMessage[] {
  if (typeof body === "string") return body ? [{ role: "prompt", parts: [{ type: "text", text: body }] }] : [];
  if (!isRecord(body)) return [];
  const out = systemOf(body.system ?? body.preamble);
  if (Array.isArray(body.messages)) out.push(...messagesOf(body.messages));
  else if (typeof body.message === "string") {
    for (const h of arr(body.chat_history)) {
      if (isRecord(h)) out.push({ role: COHERE_ROLES[String(h.role)] ?? String(h.role ?? "user").toLowerCase(), parts: [{ type: "text", text: str(h.message) ?? "" }] });
    }
    out.push({ role: "user", parts: [{ type: "text", text: body.message }] });
  } else {
    const prompt = str(body.prompt) ?? str(body.inputText) ?? (Array.isArray(body.texts) ? body.texts.join("\n") : undefined);
    if (prompt) out.push({ role: "user", parts: [{ type: "text", text: prompt }] });
  }
  return out;
}

const assistant = (parts: LlmPart[], role = "assistant"): LlmMessage[] => (parts.length ? [{ role, parts }] : []);
const text = (t: unknown): LlmPart[] => (typeof t === "string" && t ? [{ type: "text", text: t }] : []);

function outputMessages(res: unknown): LlmMessage[] {
  if (typeof res === "string") return assistant(text(res));
  if (!isRecord(res)) return [];
  if (Array.isArray(res.content)) return assistant(contentParts(res.content), str(res.role) ?? "assistant");
  const message = get(res, "output", "message");
  if (isRecord(message)) return assistant(contentParts(message.content), str(message.role) ?? "assistant");
  if (Array.isArray(res.choices)) {
    return res.choices.flatMap((c) => (isRecord(c) ? (isRecord(c.message) ? toMessages([c.message]) : assistant(text(c.text))) : []));
  }
  if (typeof res.generation === "string") return assistant(text(res.generation));
  if (Array.isArray(res.outputs)) return assistant(res.outputs.flatMap((o) => text(get(o, "text"))));
  if (typeof res.text === "string" || Array.isArray(res.tool_calls)) {
    const calls = arr(res.tool_calls).flatMap((c): LlmPart[] => (isRecord(c) ? [{ type: "tool_call", name: str(c.name) ?? "tool", arguments: c.parameters }] : []));
    return assistant([...text(res.text), ...calls]);
  }
  if (Array.isArray(res.generations)) return assistant(res.generations.flatMap((g) => text(get(g, "text"))));
  if (Array.isArray(res.results)) return assistant(res.results.flatMap((r) => text(get(r, "outputText"))));
  if (typeof res.completion === "string") return assistant(text(res.completion));
  return [];
}

// ---- settings, tools, usage ----------------------------------------------------------------

function settingsOf(body: unknown): LlmSetting[] {
  if (!isRecord(body)) return [];
  const inf = isRecord(body.inferenceConfig) ? body.inferenceConfig : isRecord(body.textGenerationConfig) ? body.textGenerationConfig : {};
  const extra = isRecord(body.additionalModelRequestFields) ? body.additionalModelRequestFields : {};
  const out: LlmSetting[] = [];
  const add = (label: string, ...values: unknown[]) => {
    const v = values.find((x) => x !== undefined && x !== null && x !== "");
    if (v === undefined) return;
    out.push({ label, value: Array.isArray(v) ? v.join(", ") : String(v) });
  };
  add("Max tokens", body.max_tokens, body.max_gen_len, body.max_new_tokens, body.max_completion_tokens, inf.maxTokens, inf.max_new_tokens, inf.maxTokenCount);
  add("Temperature", body.temperature, inf.temperature);
  add("Top P", body.top_p, body.p, inf.topP, inf.top_p);
  add("Top K", body.top_k, body.k, inf.topK, inf.top_k, extra.top_k);
  add("Stop sequences", body.stop_sequences, body.stop, inf.stopSequences);
  const thinking = body.thinking ?? extra.thinking;
  if (isRecord(thinking)) {
    const budget = num(thinking.budget_tokens);
    out.push({ label: "Thinking", value: `${str(thinking.type) ?? "enabled"}${budget !== undefined ? ` (budget ${budget})` : ""}` });
  }
  const choice = body.tool_choice ?? get(body, "toolConfig", "toolChoice");
  if (isRecord(choice)) add("Tool choice", str(choice.type) ?? Object.keys(choice)[0]);
  else add("Tool choice", choice);
  add("Anthropic version", body.anthropic_version);
  return out;
}

function toolsOf(body: unknown): LlmSpan["tools"] {
  const list = [...arr(get(body, "tools")), ...arr(get(body, "toolConfig", "tools"))];
  return list.flatMap((t) => {
    const def = isRecord(t) ? (isRecord(t.toolSpec) ? t.toolSpec : isRecord(t.function) ? t.function : t) : undefined;
    const name = def && str(def.name);
    return name ? [{ name, description: str(def.description) }] : [];
  });
}

function header(headers: unknown, name: string): unknown {
  if (!isRecord(headers)) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function finishReasonOf(res: unknown): string | undefined {
  const v =
    get(res, "stop_reason") ??
    get(res, "stopReason") ??
    get(res, "finish_reason") ??
    get(res, "choices", 0, "finish_reason") ??
    get(res, "outputs", 0, "stop_reason") ??
    get(res, "generations", 0, "finish_reason") ??
    get(res, "results", 0, "completionReason");
  return typeof v === "string" && v ? v : undefined;
}

// ---- span → call ---------------------------------------------------------------------------

export interface BedrockCall {
  operation: string;
  modelId?: string;
  /** The model's request body (the `body` of an InvokeModel command, the whole Converse input). */
  request: unknown;
  response: unknown;
}

/** The Bedrock Runtime model call of a span (SDK span, HTTP span or collapsed summary), if it is one. */
export function bedrockCall(span: Span): BedrockCall | undefined {
  const a = span.attributes;
  const path = bedrockPath(a["url.full"]);
  if (!path && !isBedrockService(a["rpc.service"])) return undefined;
  const method = a["rpc.method"];
  const operation = method && OPERATIONS.has(method) ? method : path?.operation;
  if (!operation) return undefined;

  const req = parse(a["ivy.payload.request"]);
  const res = parse(a["ivy.payload.response"]);
  const fromSdk = isRecord(req) && "modelId" in req;
  const converse = operation.startsWith("Converse");
  const request = fromSdk && !converse ? parse(req.body) : req;
  const response = isRecord(res) && "body" in res && !converse ? parse(res.body) : res;
  const modelId = a["gen_ai.request.model"] || (fromSdk ? str(req.modelId) : undefined) || path?.modelId;
  return { operation, modelId, request, response };
}

/** The normalized LLM view of a Bedrock Runtime span. */
export function describeBedrock(span: Span): LlmSpan | undefined {
  const call = bedrockCall(span);
  if (!call) return undefined;
  const a = span.attributes;
  const { request: req, response: res, operation } = call;
  const headers = parse(a["ivy.http.response.headers"]);
  const usage = get(res, "usage");
  const metrics = get(res, "amazon-bedrock-invocationMetrics");
  const billed = get(res, "meta", "billed_units");

  const inputTokens = num(
    a["ivy.collapsed.input_tokens"],
    a["gen_ai.usage.input_tokens"],
    get(usage, "input_tokens"),
    get(usage, "inputTokens"),
    get(usage, "prompt_tokens"),
    get(res, "prompt_token_count"),
    get(billed, "input_tokens"),
    get(res, "inputTextTokenCount"),
    get(metrics, "inputTokenCount"),
    header(headers, "x-amzn-bedrock-input-token-count"),
  );
  const resultTokens = arr(get(res, "results")).reduce<number | undefined>((sum, r) => {
    const n = num(get(r, "tokenCount"));
    return n === undefined ? sum : (sum ?? 0) + n;
  }, undefined);
  const outputTokens = num(
    a["ivy.collapsed.output_tokens"],
    a["gen_ai.usage.output_tokens"],
    get(usage, "output_tokens"),
    get(usage, "outputTokens"),
    get(usage, "completion_tokens"),
    get(res, "generation_token_count"),
    get(billed, "output_tokens"),
    resultTokens,
    get(metrics, "outputTokenCount"),
    header(headers, "x-amzn-bedrock-output-token-count"),
  );
  const cached = num(get(usage, "cache_read_input_tokens"), get(usage, "cacheReadInputTokens"), get(usage, "prompt_tokens_details", "cached_tokens"));
  const ttftSeconds = num(a["gen_ai.response.time_to_first_chunk"]);
  const ttftMs = ttftSeconds !== undefined ? ttftSeconds * 1000 : num(get(metrics, "firstByteLatency"));

  const responseModel = str(get(res, "model")) ?? a["gen_ai.response.model"];
  const model = call.modelId ? shortModelName(call.modelId) : responseModel;
  const finish = finishReasonOf(res) ?? (a["gen_ai.response.finish_reasons"] ? String(parse(a["gen_ai.response.finish_reasons"])) : undefined);
  const embedding = /embed/i.test(call.modelId ?? "") || a["gen_ai.operation.name"] === "embeddings";

  return {
    kind: embedding ? "embedding" : "call",
    operation,
    name: `BedrockRuntime.${operation}`,
    provider: "bedrock",
    providerLabel: "Amazon Bedrock",
    vendor: vendorOf(call.modelId, req, res),
    model,
    modelId: call.modelId && call.modelId !== model ? call.modelId : undefined,
    responseModel: responseModel && responseModel !== model ? responseModel : undefined,
    streaming: /Stream$/.test(operation),
    inputTokens,
    outputTokens,
    totalTokens: num(get(usage, "totalTokens"), get(usage, "total_tokens")) ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined),
    cachedInputTokens: cached || undefined,
    ttftMs,
    finishReason: finish,
    settings: settingsOf(req),
    messages: inputMessages(req),
    output: outputMessages(res),
    tools: toolsOf(req),
  };
}
