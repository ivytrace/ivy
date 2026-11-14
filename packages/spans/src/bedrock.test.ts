import { describe, expect, it } from "vitest";
import { bedrockPath, shortModelName } from "./bedrock.js";
import { buildServiceGraph } from "./graph.js";
import { describeLlm, llmUsage } from "./llm.js";
import { describeSpan } from "./services.js";
import type { Span } from "./types.js";

let n = 0;
const span = (name: string, attributes: Record<string, string>, extra: Partial<Span> = {}): Span => ({
  span_id: `b${++n}`,
  parent_span_id: "",
  name,
  kind: "CLIENT",
  service: "support-triageTicket",
  start: "2026-11-14T12:00:00.000Z",
  end: "2026-11-14T12:00:00.700Z",
  duration_ms: 700,
  status_code: "UNSET",
  status_message: "",
  attributes,
  resource: {},
  events: [],
  ...extra,
});

const MODEL_ID = "eu.anthropic.claude-haiku-5-5-20261001-v1:0";
const SYSTEM = "You triage customer support tickets. Reply with JSON only.";
const TICKET = "My order ord_8812 still hasn't arrived. Can you check?";

// The shape of a real production capture: Anthropic messages on InvokeModel.
const anthropicRequest = {
  anthropic_version: "bedrock-2023-05-31",
  system: SYSTEM,
  messages: [{ role: "user", content: [{ type: "text", text: TICKET }] }],
  max_tokens: 1024,
  thinking: { type: "enabled", budget_tokens: 512 },
};
const anthropicResponse = {
  id: "msg_bdrk_01",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5-20261001",
  content: [
    { type: "thinking", thinking: "Shipping question." },
    { type: "text", text: '{"category":"shipping"}' },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 412, output_tokens: 38, cache_read_input_tokens: 100 },
};

const sdk = (operation: string, request: unknown, response: unknown, extra: Record<string, string> = {}) =>
  span(`BedrockRuntime.${operation}`, {
    "rpc.system": "aws-api",
    "rpc.service": "BedrockRuntime",
    "rpc.method": operation,
    "cloud.region": "eu-west-1",
    "ivy.payload.request": JSON.stringify(request),
    "ivy.payload.response": JSON.stringify(response),
    ...extra,
  });

const invoke = (modelId: string, body: unknown, response: unknown) =>
  sdk("InvokeModel", { modelId, contentType: "application/json", body }, { contentType: "application/json", body: response });

describe("describeLlm on Amazon Bedrock", () => {
  it("reads an Anthropic messages body on InvokeModel (AWS SDK span)", () => {
    const s = invoke(MODEL_ID, anthropicRequest, anthropicResponse);
    const l = describeLlm(s)!;
    expect(l).toMatchObject({
      kind: "call",
      operation: "InvokeModel",
      name: "BedrockRuntime.InvokeModel",
      provider: "bedrock",
      providerLabel: "Amazon Bedrock",
      vendor: "Anthropic",
      model: "claude-haiku-5-5",
      modelId: MODEL_ID,
      responseModel: "claude-haiku-5-5-20261001",
      streaming: false,
      inputTokens: 412,
      outputTokens: 38,
      totalTokens: 450,
      cachedInputTokens: 100,
      finishReason: "end_turn",
    });
    expect(l.messages).toEqual([
      { role: "system", parts: [{ type: "text", text: SYSTEM }] },
      { role: "user", parts: [{ type: "text", text: TICKET }] },
    ]);
    expect(l.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Shipping question." },
          { type: "text", text: '{"category":"shipping"}' },
        ],
      },
    ]);
    expect(l.settings).toEqual([
      { label: "Max tokens", value: "1024" },
      { label: "Thinking", value: "enabled (budget 512)" },
      { label: "Anthropic version", value: "bedrock-2023-05-31" },
    ]);

    const d = describeSpan(s);
    expect(d).toMatchObject({ icon: "ai", serviceLabel: "Amazon Bedrock", operation: "InvokeModel", target: "claude-haiku-5-5", graphLabel: "Bedrock · Anthropic" });
    expect(d.note).toBe("412 → 38 tokens · Amazon Bedrock");
    expect(d.fields).toContainEqual({ label: "Model ID", value: MODEL_ID });
  });

  it("reads Anthropic tool use and tool results", () => {
    const l = describeLlm(
      invoke(
        MODEL_ID,
        {
          ...anthropicRequest,
          tools: [{ name: "getOrder", description: "Look up an order", input_schema: { type: "object" } }],
          messages: [
            { role: "user", content: TICKET },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "getOrder", input: { orderId: "ord_8812" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"status":"shipped"}' }] },
          ],
        },
        { ...anthropicResponse, content: [{ type: "tool_use", id: "toolu_2", name: "getOrder", input: { orderId: "ord_1" } }], stop_reason: "tool_use" },
      ),
    )!;
    expect(l.tools).toEqual([{ name: "getOrder", description: "Look up an order" }]);
    expect(l.messages[2].parts[0]).toEqual({ type: "tool_call", id: "toolu_1", name: "getOrder", arguments: { orderId: "ord_8812" } });
    expect(l.messages[3].parts[0]).toEqual({ type: "tool_result", id: "toolu_1", name: undefined, result: { status: "shipped" } });
    expect(l.output[0].parts[0]).toMatchObject({ type: "tool_call", name: "getOrder" });
    expect(l.finishReason).toBe("tool_use");
  });

  it("reads the Converse API: content blocks, tool use and results, usage, inference config", () => {
    const l = describeLlm(
      sdk(
        "Converse",
        {
          modelId: "eu.amazon.nova-lite-v1:0",
          system: [{ text: "Draft a reply." }],
          messages: [
            { role: "user", content: [{ text: TICKET }] },
            { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "getOrder", input: { orderId: "ord_8812" } } }] },
            { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ json: { status: "shipped" } }] } }] },
          ],
          inferenceConfig: { maxTokens: 512, temperature: 0.3, topP: 0.9 },
          toolConfig: { tools: [{ toolSpec: { name: "getOrder", description: "Look up an order" } }] },
        },
        { output: { message: { role: "assistant", content: [{ text: "It shipped." }] } }, stopReason: "end_turn", usage: { inputTokens: 655, outputTokens: 61, totalTokens: 716 } },
      ),
    )!;
    expect(l).toMatchObject({ operation: "Converse", vendor: "Amazon", model: "nova-lite", inputTokens: 655, outputTokens: 61, totalTokens: 716, finishReason: "end_turn" });
    expect(l.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(l.messages[2].parts[0]).toEqual({ type: "tool_call", id: "t1", name: "getOrder", arguments: { orderId: "ord_8812" } });
    expect(l.messages[3].parts[0]).toEqual({ type: "tool_result", id: "t1", result: { status: "shipped" } });
    expect(l.output).toEqual([{ role: "assistant", parts: [{ type: "text", text: "It shipped." }] }]);
    expect(l.settings).toEqual([
      { label: "Max tokens", value: "512" },
      { label: "Temperature", value: "0.3" },
      { label: "Top P", value: "0.9" },
    ]);
    expect(l.tools).toEqual([{ name: "getOrder", description: "Look up an order" }]);
  });

  it("reads Amazon Nova bodies on InvokeModel", () => {
    const l = describeLlm(
      invoke(
        "amazon.nova-pro-v1:0",
        { schemaVersion: "messages-v1", system: [{ text: "Translate to Dutch." }], messages: [{ role: "user", content: [{ text: "Hello" }] }], inferenceConfig: { maxTokens: 300 } },
        { output: { message: { role: "assistant", content: [{ text: "Hallo" }] } }, stopReason: "end_turn", usage: { inputTokens: 58, outputTokens: 29 } },
      ),
    )!;
    expect(l).toMatchObject({ vendor: "Amazon", model: "nova-pro", inputTokens: 58, outputTokens: 29, finishReason: "end_turn" });
    expect(l.messages).toEqual([
      { role: "system", parts: [{ type: "text", text: "Translate to Dutch." }] },
      { role: "user", parts: [{ type: "text", text: "Hello" }] },
    ]);
    expect(l.output[0].parts).toEqual([{ type: "text", text: "Hallo" }]);
  });

  it("reads Meta Llama, Mistral and Cohere bodies best effort", () => {
    const llama = describeLlm(
      invoke("meta.llama3-1-70b-instruct-v1:0", { prompt: "Say hi", max_gen_len: 64, temperature: 0.5 }, { generation: "Hi!", prompt_token_count: 12, generation_token_count: 3, stop_reason: "stop" }),
    )!;
    expect(llama).toMatchObject({ vendor: "Meta", model: "llama3-1-70b-instruct", inputTokens: 12, outputTokens: 3, finishReason: "stop" });
    expect(llama.messages[0].parts).toEqual([{ type: "text", text: "Say hi" }]);
    expect(llama.output[0].parts).toEqual([{ type: "text", text: "Hi!" }]);
    expect(llama.settings).toContainEqual({ label: "Max tokens", value: "64" });

    const mistral = describeLlm(invoke("mistral.mistral-7b-instruct-v0:2", { prompt: "<s>[INST] Hi [/INST]", max_tokens: 50 }, { outputs: [{ text: "Hello", stop_reason: "stop" }] }))!;
    expect(mistral).toMatchObject({ vendor: "Mistral", finishReason: "stop" });
    expect(mistral.output[0].parts).toEqual([{ type: "text", text: "Hello" }]);

    const mistralChat = describeLlm(
      invoke("mistral.mistral-large-2407-v1:0", { messages: [{ role: "user", content: "Hi" }] }, { choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    )!;
    expect(mistralChat).toMatchObject({ inputTokens: 5, outputTokens: 2, finishReason: "stop" });
    expect(mistralChat.output[0].parts).toEqual([{ type: "text", text: "Hello" }]);

    const cohere = describeLlm(
      invoke(
        "cohere.command-r-plus-v1:0",
        { preamble: "Be brief.", chat_history: [{ role: "USER", message: "Hi" }, { role: "CHATBOT", message: "Hello" }], message: "Where is ord_8812?", max_tokens: 100 },
        { text: "It shipped.", finish_reason: "COMPLETE", meta: { billed_units: { input_tokens: 20, output_tokens: 4 } } },
      ),
    )!;
    expect(cohere).toMatchObject({ vendor: "Cohere", inputTokens: 20, outputTokens: 4, finishReason: "COMPLETE" });
    expect(cohere.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(cohere.output[0].parts).toEqual([{ type: "text", text: "It shipped." }]);
  });

  it("reads HTTP-level spans of older layers (bundled SDK): operation and model from the URL, tokens from headers", () => {
    const s = span("POST bedrock-runtime.eu-west-1.amazonaws.com", {
      "http.request.method": "POST",
      "url.full": `https://bedrock-runtime.eu-west-1.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/invoke`,
      "server.address": "bedrock-runtime.eu-west-1.amazonaws.com",
      "rpc.system": "aws-api",
      "rpc.service": "Bedrock",
      "cloud.region": "eu-west-1",
      "ivy.http.response.headers": JSON.stringify({ "x-amzn-bedrock-input-token-count": "412", "x-amzn-bedrock-output-token-count": "38" }),
      // Before the redaction fix, token counts in bodies were redacted.
      "ivy.payload.request": JSON.stringify({ ...anthropicRequest, max_tokens: "[redacted]" }),
      "ivy.payload.response": JSON.stringify({ ...anthropicResponse, usage: { input_tokens: "[redacted]", output_tokens: "[redacted]" } }),
    });
    const l = describeLlm(s)!;
    expect(l).toMatchObject({ operation: "InvokeModel", name: "BedrockRuntime.InvokeModel", model: "claude-haiku-5-5", inputTokens: 412, outputTokens: 38, finishReason: "end_turn" });
    expect(l.messages).toHaveLength(2);
    const d = describeSpan(s);
    expect(d.operation).toBe("InvokeModel");
    expect(d.target).toBe("claude-haiku-5-5");
  });

  it("uses the layer's gen_ai attributes (streams, collapsed summaries) and time to first chunk", () => {
    const l = describeLlm(
      sdk(
        "InvokeModelWithResponseStream",
        { modelId: MODEL_ID, body: anthropicRequest },
        { body: { role: "assistant", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" } },
        { "gen_ai.usage.input_tokens": "40", "gen_ai.usage.output_tokens": "9", "gen_ai.response.time_to_first_chunk": "0.318" },
      ),
    )!;
    expect(l).toMatchObject({ streaming: true, inputTokens: 40, outputTokens: 9, ttftMs: 318 });

    const summary = span("BedrockRuntime.InvokeModel × 40", {
      "rpc.system": "aws-api",
      "rpc.service": "BedrockRuntime",
      "rpc.method": "InvokeModel",
      "gen_ai.system": "aws.bedrock",
      "gen_ai.request.model": MODEL_ID,
      "ivy.collapsed.count": "40",
      "ivy.collapsed.input_tokens": "16480",
      "ivy.collapsed.output_tokens": "1520",
    });
    expect(describeLlm(summary)).toMatchObject({ model: "claude-haiku-5-5", inputTokens: 16480, outputTokens: 1520 });
    expect(llmUsage([summary])).toMatchObject({ calls: 40, inputTokens: 16480, outputTokens: 1520 });
  });

  it("makes one Bedrock graph node per model maker, under the function", () => {
    const root = span("support-triageTicket", { "ivy.invocation": "true", "ivy.trigger.source": "aws:sqs" }, { kind: "CONSUMER" });
    const a = { ...invoke(MODEL_ID, anthropicRequest, anthropicResponse), parent_span_id: root.span_id };
    const b = { ...invoke(MODEL_ID, anthropicRequest, anthropicResponse), parent_span_id: root.span_id };
    const { nodes, edges } = buildServiceGraph([root, a, b]);
    const node = nodes.find((x) => x.icon === "ai")!;
    expect(node).toMatchObject({ label: "Bedrock · Anthropic", instances: 2 });
    expect(edges).toContainEqual(expect.objectContaining({ source: "fn:support-triageTicket", target: node.id }));
    expect(nodes.map((x) => x.label)).not.toContain("Bedrock");
  });

  it("keeps a Bedrock request under an AI SDK model call in the model call's node", () => {
    const call = span("ai.generateText.doGenerate", { "ai.operationId": "ai.generateText.doGenerate", "ai.model.provider": "amazon-bedrock", "ai.model.id": MODEL_ID, "ai.usage.inputTokens": "412", "ai.usage.outputTokens": "38" });
    const http = { ...invoke(MODEL_ID, anthropicRequest, anthropicResponse), parent_span_id: call.span_id };
    const { nodes } = buildServiceGraph([call, http]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].instances).toBe(1);
    expect(llmUsage([call, http])).toMatchObject({ calls: 1, inputTokens: 412, outputTokens: 38 });
  });

  it("is not an LLM span for other Bedrock operations", () => {
    expect(describeLlm(sdk("ApplyGuardrail", {}, {}))).toBeUndefined();
    expect(describeSpan(sdk("ApplyGuardrail", {}, {})).operation).toBe("BedrockRuntime.ApplyGuardrail");
  });
});

describe("generic AWS titles", () => {
  it("never uses the region as the operation", () => {
    const d = describeSpan(
      span("POST sts.eu-west-1.amazonaws.com", { "rpc.system": "aws-api", "rpc.service": "STS", "http.request.method": "POST", "url.full": "https://sts.eu-west-1.amazonaws.com/", "cloud.region": "eu-west-1" }),
    );
    expect(d.operation).toBe("STS.POST /");
    expect(describeSpan(span("STS.AssumeRole", { "rpc.system": "aws-api", "rpc.service": "STS", "rpc.method": "AssumeRole" })).operation).toBe("STS.AssumeRole");
  });
});

describe("helpers", () => {
  it("shortens model IDs", () => {
    expect(shortModelName(MODEL_ID)).toBe("claude-haiku-5-5");
    expect(shortModelName("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe("claude-3-5-sonnet");
    expect(shortModelName("arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.amazon.nova-lite-v1:0")).toBe("nova-lite");
    expect(shortModelName("cohere.command-r-plus-v1:0")).toBe("command-r-plus");
  });
  it("parses Bedrock Runtime paths", () => {
    expect(bedrockPath("https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse-stream")).toEqual({ operation: "ConverseStream", modelId: "amazon.nova-lite-v1:0" });
    expect(bedrockPath("https://bedrock.us-east-1.amazonaws.com/foundation-models")).toBeUndefined();
  });
});
