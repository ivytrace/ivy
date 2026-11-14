import { describe, expect, it } from "vitest";
import { buildServiceGraph } from "./graph.js";
import { describeLlm, llmUsage, normalizeProvider } from "./llm.js";
import { describeSpan } from "./services.js";
import type { Span, SpanEvent } from "./types.js";

let n = 0;
const span = (name: string, attributes: Record<string, string>, extra: Partial<Span> = {}): Span => ({
  span_id: extra.span_id ?? `s${++n}`,
  parent_span_id: "",
  name,
  kind: "INTERNAL",
  service: "support-bot",
  start: "2026-11-14T12:00:00.000Z",
  end: "2026-11-14T12:00:01.000Z",
  duration_ms: 1000,
  status_code: "UNSET",
  status_message: "",
  attributes,
  resource: {},
  events: [] as SpanEvent[],
  ...extra,
});

const doGenerate = span("ai.generateText.doGenerate", {
  "ai.operationId": "ai.generateText.doGenerate",
  "ai.model.provider": "openai.chat",
  "ai.model.id": "gpt-4o-mini",
  "ai.settings.temperature": "0.2",
  "ai.settings.maxOutputTokens": "400",
  "ai.prompt.messages": JSON.stringify([
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "Where is ord_1?" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "getOrder", input: { orderId: "ord_1" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "getOrder", output: { type: "json", value: { status: "shipped" } } }] },
  ]),
  "ai.prompt.tools": JSON.stringify([JSON.stringify({ type: "function", name: "getOrder", description: "Look up an order" })]),
  "ai.response.text": "It shipped.",
  "ai.response.finishReason": "stop",
  "ai.response.model": "gpt-4o-mini-2024-07-18",
  "ai.usage.inputTokens": "901",
  "ai.usage.outputTokens": "41",
});

describe("describeLlm", () => {
  it("reads AI SDK model-call spans: messages, tool calls and results, usage, settings", () => {
    const l = describeLlm(doGenerate)!;
    expect(l).toMatchObject({
      kind: "call",
      operation: "doGenerate",
      provider: "openai",
      providerLabel: "OpenAI",
      model: "gpt-4o-mini",
      responseModel: "gpt-4o-mini-2024-07-18",
      inputTokens: 901,
      outputTokens: 41,
      finishReason: "stop",
      tools: [{ name: "getOrder", description: "Look up an order" }],
    });
    expect(l.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(l.messages[2].parts[0]).toEqual({ type: "tool_call", id: "c1", name: "getOrder", arguments: { orderId: "ord_1" } });
    expect(l.messages[3].parts[0]).toMatchObject({ type: "tool_result", result: { status: "shipped" } });
    expect(l.output).toEqual([{ role: "assistant", parts: [{ type: "text", text: "It shipped." }] }]);
    expect(l.settings).toEqual([
      { label: "Temperature", value: "0.2" },
      { label: "Max tokens", value: "400" },
    ]);
  });

  it("reads AI SDK operations, tool calls, streams and older attribute names", () => {
    const gen = describeLlm(span("ai.generateText", { "ai.operationId": "ai.generateText", "ai.model.provider": "anthropic.messages", "ai.model.id": "claude-haiku-4-5", "ai.prompt": JSON.stringify({ system: "S", prompt: "Q" }), "ai.usage.promptTokens": "10", "ai.usage.completionTokens": "5" }))!;
    expect(gen).toMatchObject({ kind: "operation", operation: "generateText", providerLabel: "Anthropic", inputTokens: 10, outputTokens: 5 });
    expect(gen.messages.map((m) => [m.role, m.parts[0]])).toEqual([["system", { type: "text", text: "S" }], ["user", { type: "text", text: "Q" }]]);

    const tool = describeLlm(span("ai.toolCall", { "ai.operationId": "ai.toolCall", "ai.toolCall.name": "getOrder", "ai.toolCall.args": '{"orderId":"ord_1"}', "ai.toolCall.result": '{"status":"shipped"}' }))!;
    expect(tool).toMatchObject({ kind: "tool", tool: { name: "getOrder", arguments: { orderId: "ord_1" }, result: { status: "shipped" } } });

    const stream = describeLlm(span("ai.streamText.doStream", { "ai.operationId": "ai.streamText.doStream", "ai.model.provider": "openai.responses", "ai.response.msToFirstChunk": "318.4" }))!;
    expect(stream).toMatchObject({ kind: "call", operation: "doStream", streaming: true, ttftMs: 318.4 });
  });

  it("reads GenAI semantic-convention spans (AI SDK 7, OpenAI/Anthropic instrumentations)", () => {
    const chat = describeLlm(
      span("chat gpt-4o-mini", {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.system_instructions": JSON.stringify([{ type: "text", content: "Be brief." }]),
        "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Where is ord_1?" }] }]),
        "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "getOrder", arguments: { orderId: "ord_1" } }], finish_reason: "tool_call" }]),
        "gen_ai.response.finish_reasons": '["tool_calls"]',
        "gen_ai.usage.input_tokens": "812",
        "gen_ai.usage.output_tokens": "24",
        "gen_ai.client.operation.time_to_first_chunk": "0.32",
      }),
    )!;
    expect(chat).toMatchObject({ kind: "call", operation: "chat", providerLabel: "OpenAI", inputTokens: 812, outputTokens: 24, ttftMs: 320, finishReason: "tool_calls" });
    expect(chat.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(chat.output[0].parts[0]).toMatchObject({ type: "tool_call", name: "getOrder" });

    expect(describeLlm(span("invoke_agent gpt-4o-mini", { "gen_ai.operation.name": "invoke_agent" }))?.kind).toBe("operation");
    expect(describeLlm(span("step 1", { "gen_ai.operation.name": "agent_step" }))).toMatchObject({ kind: "step", operation: "step 1" });
    expect(describeLlm(span("execute_tool getOrder", { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "getOrder", "gen_ai.tool.call.result": '{"ok":true}' }))?.tool).toMatchObject({ name: "getOrder", result: { ok: true } });
  });

  it("reads indexed (OpenLLMetry) and event-based message formats", () => {
    const indexed = describeLlm(
      span("anthropic.chat", {
        "gen_ai.system": "Anthropic",
        "llm.request.type": "chat",
        "gen_ai.request.model": "claude-sonnet-4-5",
        "gen_ai.prompt.0.role": "user",
        "gen_ai.prompt.0.content": "Hello",
        "gen_ai.completion.0.role": "assistant",
        "gen_ai.completion.0.content": "Hi!",
        "gen_ai.completion.0.tool_calls.0.name": "lookup",
        "gen_ai.completion.0.tool_calls.0.arguments": '{"q":"x"}',
        "gen_ai.usage.prompt_tokens": "7",
        "gen_ai.usage.completion_tokens": "3",
      }),
    )!;
    expect(indexed).toMatchObject({ kind: "call", providerLabel: "Anthropic", inputTokens: 7, outputTokens: 3 });
    expect(indexed.output[0].parts).toEqual([{ type: "text", text: "Hi!" }, { type: "tool_call", id: undefined, name: "lookup", arguments: { q: "x" } }]);

    const events = describeLlm(
      span("chat gpt-4o", { "gen_ai.system": "openai", "gen_ai.request.model": "gpt-4o" }, {
        events: [
          { ts: "", name: "gen_ai.user.message", attributes: { content: "Hello" } },
          { ts: "", name: "gen_ai.choice", attributes: { message: JSON.stringify({ role: "assistant", content: "Hi there" }) } },
        ],
      }),
    )!;
    expect(events.messages[0]).toEqual({ role: "user", parts: [{ type: "text", text: "Hello" }] });
    expect(events.output[0].parts[0]).toEqual({ type: "text", text: "Hi there" });
  });

  it("reads OpenInference spans", () => {
    const l = describeLlm(
      span("ChatOpenAI", {
        "openinference.span.kind": "LLM",
        "llm.model_name": "gpt-4o",
        "llm.provider": "openai",
        "llm.input_messages.0.message.role": "user",
        "llm.input_messages.0.message.content": "Hi",
        "llm.output_messages.0.message.role": "assistant",
        "llm.output_messages.0.message.content": "Hello",
        "llm.token_count.prompt": "5",
        "llm.token_count.completion": "2",
      }),
    )!;
    expect(l).toMatchObject({ kind: "call", model: "gpt-4o", providerLabel: "OpenAI", inputTokens: 5, outputTokens: 2 });
    expect(l.messages[0].parts[0]).toEqual({ type: "text", text: "Hi" });
  });

  it("keeps a prompt cut at the source as text", () => {
    const l = describeLlm(span("ai.generateText.doGenerate", { "ai.operationId": "ai.generateText.doGenerate", "ai.prompt.messages": '[{"role":"user","content":"long…[truncated 9000 bytes]' }))!;
    expect(l.messages[0].role).toBe("prompt");
  });

  it("ignores other spans and normalizes providers", () => {
    expect(describeLlm(span("DynamoDB.GetItem", { "rpc.system": "aws-api" }))).toBeUndefined();
    expect(normalizeProvider("gcp.vertex_ai")?.label).toBe("Vertex AI");
    expect(normalizeProvider("amazon-bedrock")?.label).toBe("Amazon Bedrock");
    expect(normalizeProvider("azure.ai.openai")?.label).toBe("Azure OpenAI");
    expect(normalizeProvider(undefined, "claude-3-5-sonnet")?.label).toBe("Anthropic");
    expect(normalizeProvider("acme-llm.chat")).toEqual({ id: "acme-llm", label: "acme-llm" });
  });
});

describe("LLM spans in traces", () => {
  const root = span("support-bot", { "ivy.invocation": "true", "ivy.trigger.source": "aws:apigatewayv2" }, { span_id: "root" });
  const gen = span("ai.generateText", { "ai.operationId": "ai.generateText", "ai.model.provider": "openai.chat", "ai.model.id": "gpt-4o-mini", "ai.usage.inputTokens": "1713", "ai.usage.outputTokens": "65" }, { span_id: "gen", parent_span_id: "root" });
  const call1 = { ...doGenerate, span_id: "c1", parent_span_id: "gen", attributes: { ...doGenerate.attributes, "ai.usage.inputTokens": "812", "ai.usage.outputTokens": "24" } };
  const http1 = span("POST api.openai.com", { "http.request.method": "POST", "url.full": "https://api.openai.com/v1/chat/completions" }, { span_id: "h1", parent_span_id: "c1", kind: "CLIENT" });
  const tool = span("ai.toolCall", { "ai.operationId": "ai.toolCall", "ai.toolCall.name": "getOrder" }, { span_id: "tool", parent_span_id: "gen" });
  const ddb = span("DynamoDB.GetItem", { "rpc.system": "aws-api", "rpc.service": "DynamoDB", "rpc.method": "GetItem", "aws.dynamodb.table_names": '["orders"]' }, { span_id: "ddb", parent_span_id: "tool", kind: "CLIENT" });
  const call2 = { ...doGenerate, span_id: "c2", parent_span_id: "gen" };
  const spans = [root, gen, call1, http1, tool, ddb, call2];

  it("sums token usage of model calls without counting operations twice", () => {
    expect(llmUsage(spans)).toEqual({
      calls: 2,
      inputTokens: 1713,
      outputTokens: 65,
      byModel: [{ provider: "openai", providerLabel: "OpenAI", model: "gpt-4o-mini", calls: 2, inputTokens: 1713, outputTokens: 65 }],
    });
    expect(llmUsage([root, ddb])).toBeUndefined();
  });

  it("describes LLM spans for rows: AI icon, operation, model, token note", () => {
    expect(describeSpan(call1)).toMatchObject({ icon: "ai", serviceLabel: "OpenAI", operation: "doGenerate", target: "gpt-4o-mini", note: "812 → 24 tokens · OpenAI" });
    expect(describeSpan(tool)).toMatchObject({ icon: "ai", operation: "tool", target: "getOrder" });
  });

  it("shows the provider as one graph node; tools and the provider's HTTP calls are folded away", () => {
    const { nodes, edges } = buildServiceGraph(spans);
    const label = (id: string) => nodes.find((x) => x.id === id)!.label;
    expect(nodes.map((x) => [x.label, x.icon, x.instances])).toEqual([
      ["support-bot", "lambda", 1],
      ["OpenAI", "ai", 2],
      ["orders", "dynamodb", 1],
      ["API Gateway", "apigw", 1],
    ]);
    expect(edges.map((e) => `${label(e.source)} → ${label(e.target)}`).sort()).toEqual(["API Gateway → support-bot", "support-bot → OpenAI", "support-bot → orders"]);
  });
});
