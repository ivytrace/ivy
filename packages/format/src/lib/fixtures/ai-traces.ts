/**
 * LLM traces: an API Gateway → Lambda support bot that calls generateText with a tool (a DynamoDB
 * lookup), then streams a reply. One with the Vercel AI SDK's `ai.*` spans (AI SDK 6, the shape most
 * apps emit today), one with GenAI semantic-convention spans (AI SDK 7's `@ai-sdk/otel`). Attribute
 * values follow what the layer captured from the real SDKs in its e2e test.
 */

export const SYSTEM = "You are the support assistant for an online shop. Be concise. Use the tools to look orders up; never guess.";
export const QUESTION = "Hi! Where is my order ord_8812? It was supposed to arrive on Monday.";
export const ORDER = { orderId: "ord_8812", status: "shipped", carrier: "DHL", trackingNumber: "JD014600006281", eta: "2026-11-19" };
export const ANSWER =
  "Your order **ord_8812** shipped yesterday with DHL.\n\n- Tracking number: `JD014600006281`\n- Expected delivery: Thursday, 19 November\n\nSorry for the delay!";
export const REWRITE_SYSTEM = "Rewrite support answers in a warm, short tone. Keep the facts.";
export const REPLY =
  "Hi Ada! Good news: your order ord_8812 is on its way with DHL (tracking JD014600006281) and should arrive on Thursday. Sorry it's later than planned!";

const tools = [
  JSON.stringify({
    type: "function",
    name: "getOrder",
    description: "Look up an order by ID",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  }),
];

const toolCall = { toolCallId: "call_7Yk2", toolName: "getOrder", input: JSON.stringify({ orderId: "ord_8812" }) };

const firstPrompt = [
  { role: "system", content: SYSTEM },
  { role: "user", content: [{ type: "text", text: QUESTION }] },
];
const secondPrompt = [
  ...firstPrompt,
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_7Yk2", toolName: "getOrder", input: { orderId: "ord_8812" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call_7Yk2", toolName: "getOrder", output: { type: "json", value: ORDER } }] },
];

const usage = (input: number, output: number, prefix = "ai.usage") => ({
  [`${prefix}.inputTokens`]: String(input),
  [`${prefix}.outputTokens`]: String(output),
  [`${prefix}.totalTokens`]: String(input + output),
});

const common = (provider: string, model: string) => ({
  "ai.model.provider": provider,
  "ai.model.id": model,
  "ai.telemetry.functionId": "support-answer",
  "ai.settings.maxRetries": "2",
  "resource.name": "support-answer",
  "otel.scope.name": "ai",
});

/** Attributes per span of the AI SDK 6 trace (`ai.*` + the `gen_ai.*` attributes the SDK adds to model calls). */
export const aiSdkAttributes = {
  generateText: {
    ...common("openai.chat", "gpt-4o-mini"),
    "ai.operationId": "ai.generateText",
    "operation.name": "ai.generateText support-answer",
    "ai.settings.temperature": "0.2",
    "ai.settings.maxOutputTokens": "400",
    "ai.prompt": JSON.stringify({ system: SYSTEM, prompt: QUESTION }),
    "ai.response.text": ANSWER,
    "ai.response.finishReason": "stop",
    ...usage(1713, 65),
  },
  doGenerate: (step: 1 | 2) => ({
    ...common("openai.chat", "gpt-4o-mini"),
    "ai.operationId": "ai.generateText.doGenerate",
    "operation.name": "ai.generateText.doGenerate support-answer",
    "ai.settings.temperature": "0.2",
    "ai.settings.maxOutputTokens": "400",
    "ai.prompt.messages": JSON.stringify(step === 1 ? firstPrompt : secondPrompt),
    "ai.prompt.tools": JSON.stringify(tools),
    "ai.prompt.toolChoice": JSON.stringify({ type: "auto" }),
    "gen_ai.system": "openai.chat",
    "gen_ai.request.model": "gpt-4o-mini",
    "gen_ai.request.temperature": "0.2",
    "gen_ai.request.max_tokens": "400",
    "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
    "gen_ai.response.id": step === 1 ? "chatcmpl-AX81" : "chatcmpl-AX82",
    "ai.response.model": "gpt-4o-mini-2024-07-18",
    "ai.response.id": step === 1 ? "chatcmpl-AX81" : "chatcmpl-AX82",
    ...(step === 1
      ? { "ai.response.finishReason": "tool-calls", "ai.response.toolCalls": JSON.stringify([toolCall]), "gen_ai.response.finish_reasons": '["tool-calls"]' }
      : { "ai.response.finishReason": "stop", "ai.response.text": ANSWER, "gen_ai.response.finish_reasons": '["stop"]' }),
    ...(step === 1 ? usage(812, 24) : usage(901, 41)),
    "gen_ai.usage.input_tokens": step === 1 ? "812" : "901",
    "gen_ai.usage.output_tokens": step === 1 ? "24" : "41",
  }),
  toolCall: {
    "otel.scope.name": "ai",
    "ai.operationId": "ai.toolCall",
    "operation.name": "ai.toolCall support-answer",
    "ai.telemetry.functionId": "support-answer",
    "ai.toolCall.name": "getOrder",
    "ai.toolCall.id": "call_7Yk2",
    "ai.toolCall.args": JSON.stringify({ orderId: "ord_8812" }),
    "ai.toolCall.result": JSON.stringify(ORDER),
  },
  streamText: {
    ...common("anthropic.messages", "claude-haiku-4-5"),
    "ai.operationId": "ai.streamText",
    "operation.name": "ai.streamText support-answer",
    "ai.settings.temperature": "0.7",
    "ai.prompt": JSON.stringify({ system: REWRITE_SYSTEM, prompt: ANSWER }),
    "ai.response.text": REPLY,
    "ai.response.finishReason": "stop",
    ...usage(164, 38),
  },
  doStream: (ttftMs: number) => ({
    ...common("anthropic.messages", "claude-haiku-4-5"),
    "ai.operationId": "ai.streamText.doStream",
    "operation.name": "ai.streamText.doStream support-answer",
    "ai.settings.temperature": "0.7",
    "ai.prompt.messages": JSON.stringify([
      { role: "system", content: REWRITE_SYSTEM },
      { role: "user", content: [{ type: "text", text: ANSWER }] },
    ]),
    "gen_ai.system": "anthropic.messages",
    "gen_ai.request.model": "claude-haiku-4-5",
    "gen_ai.request.temperature": "0.7",
    "gen_ai.response.model": "claude-haiku-4-5-20251001",
    "gen_ai.response.finish_reasons": '["stop"]',
    "ai.response.model": "claude-haiku-4-5-20251001",
    "ai.response.msToFirstChunk": String(ttftMs),
    "ai.response.finishReason": "stop",
    "ai.response.text": REPLY,
    ...usage(164, 38),
    "gen_ai.usage.input_tokens": "164",
    "gen_ai.usage.output_tokens": "38",
  }),
};

const parts = (text: string) => [{ type: "text", content: text }];

/** Attributes per span of the AI SDK 7 trace (GenAI semantic conventions). */
export const genAiAttributes = {
  agent: {
    "otel.scope.name": "gen_ai",
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-4o-mini",
    "gen_ai.agent.name": "support-answer",
    "gen_ai.request.temperature": "0.2",
    "gen_ai.request.max_tokens": "400",
    "gen_ai.system_instructions": JSON.stringify(parts(SYSTEM)),
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: parts(QUESTION) }]),
    "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: parts(ANSWER), finish_reason: "stop" }]),
    "gen_ai.response.finish_reasons": '["stop"]',
    "gen_ai.usage.input_tokens": "1713",
    "gen_ai.usage.output_tokens": "65",
  },
  step: { "otel.scope.name": "gen_ai", "gen_ai.operation.name": "agent_step" },
  chat: (step: 1 | 2) => ({
    "otel.scope.name": "gen_ai",
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-4o-mini",
    "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
    "gen_ai.request.temperature": "0.2",
    "gen_ai.request.max_tokens": "400",
    "server.address": "api.openai.com",
    "server.port": "443",
    "gen_ai.system_instructions": JSON.stringify(parts(SYSTEM)),
    "gen_ai.tool.definitions": JSON.stringify(tools.map((t) => JSON.parse(t))),
    "gen_ai.input.messages": JSON.stringify([
      { role: "user", parts: parts(QUESTION) },
      ...(step === 2
        ? [
            { role: "assistant", parts: [{ type: "tool_call", id: "call_7Yk2", name: "getOrder", arguments: { orderId: "ord_8812" } }] },
            { role: "tool", parts: [{ type: "tool_call_response", id: "call_7Yk2", response: ORDER }] },
          ]
        : []),
    ]),
    "gen_ai.output.messages": JSON.stringify(
      step === 1
        ? [{ role: "assistant", parts: [{ type: "tool_call", id: "call_7Yk2", name: "getOrder", arguments: { orderId: "ord_8812" } }], finish_reason: "tool_call" }]
        : [{ role: "assistant", parts: parts(ANSWER), finish_reason: "stop" }],
    ),
    "gen_ai.response.finish_reasons": step === 1 ? '["tool-calls"]' : '["stop"]',
    "gen_ai.usage.input_tokens": step === 1 ? "812" : "901",
    "gen_ai.usage.output_tokens": step === 1 ? "24" : "41",
  }),
  tool: {
    "otel.scope.name": "gen_ai",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "getOrder",
    "gen_ai.tool.call.id": "call_7Yk2",
    "gen_ai.tool.type": "function",
    "gen_ai.tool.call.arguments": JSON.stringify({ orderId: "ord_8812" }),
    "gen_ai.tool.call.result": JSON.stringify(ORDER),
  },
};
