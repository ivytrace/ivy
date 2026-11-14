// A support assistant: generateText with a tool that looks the order up, then a streamed reply.
// Shared by the AI SDK example handlers (e2e) and the bridge's unit tests. Models are the AI SDK's
// mock models, so no LLM API is called.

const usage = (input, output) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const finish = (unified) => ({ unified, raw: unified === 'tool-calls' ? 'tool_calls' : unified });

export const REPLY = 'Your order ord_8812 shipped yesterday with DHL and should arrive on Thursday.';
const STREAMED = ['Hi Ada! ', 'Good news: ', 'your order ord_8812 is on its way ', 'and should arrive on Thursday.'];

/** `Mock` is MockLanguageModelV3 (AI SDK 6) or MockLanguageModelV4 (AI SDK 7). */
export function supportModels({ Mock, simulateReadableStream }) {
  const chat = new Mock({
    provider: 'openai.chat',
    modelId: 'gpt-4o-mini',
    doGenerate: [
      {
        content: [{ type: 'tool-call', toolCallId: 'call_order_1', toolName: 'getOrder', input: JSON.stringify({ orderId: 'ord_8812' }) }],
        finishReason: finish('tool-calls'),
        usage: usage(812, 24),
        response: { id: 'chatcmpl-1', modelId: 'gpt-4o-mini-2024-07-18', timestamp: new Date() },
        warnings: [],
      },
      {
        content: [{ type: 'text', text: REPLY }],
        finishReason: finish('stop'),
        usage: usage(901, 41),
        response: { id: 'chatcmpl-2', modelId: 'gpt-4o-mini-2024-07-18', timestamp: new Date() },
        warnings: [],
      },
    ],
  });
  const stream = new Mock({
    provider: 'anthropic.messages',
    modelId: 'claude-haiku-4-5',
    doStream: {
      stream: simulateReadableStream({
        initialDelayInMs: 40,
        chunkDelayInMs: 5,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: 'msg_01', modelId: 'claude-haiku-4-5', timestamp: new Date() },
          { type: 'text-start', id: 't1' },
          ...STREAMED.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: finish('stop'), usage: usage(164, 38) },
        ],
      }),
    },
  });
  return { chat, stream };
}

/**
 * Runs the scenario. `ai` is the AI SDK module, `telemetry` the per-call telemetry option
 * (`{ experimental_telemetry: { isEnabled: true } }` on AI SDK 6), `lookupOrder` the tool's backend.
 */
export async function answerCustomer({ ai, models, telemetry = {}, lookupOrder }) {
  const getOrder = ai.tool({
    description: 'Look up an order by ID',
    inputSchema: ai.jsonSchema({
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    }),
    execute: async ({ orderId }) => lookupOrder(orderId),
  });

  const answer = await ai.generateText({
    model: models.chat,
    system: 'You are a support assistant for an online shop. Use the tools to look orders up.',
    prompt: 'Where is my order ord_8812? My API key is sk-should-not-matter.',
    tools: { getOrder },
    stopWhen: ai.stepCountIs(3),
    temperature: 0.2,
    maxOutputTokens: 400,
    ...telemetry,
  });

  const reply = ai.streamText({
    model: models.stream,
    system: 'Rewrite support answers in a warm, short tone.',
    prompt: answer.text,
    temperature: 0.7,
    ...telemetry,
  });
  return { answer: answer.text, reply: await reply.text };
}
