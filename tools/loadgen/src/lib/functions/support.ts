import type { FunctionDef } from '../trace/generate.js';
import { InvocationBuilder, InvocationError, payload, type Attributes } from '../trace/invocation.js';
import { chance, latency, pick, randomInt, shortId, uuid } from '../trace/random.js';

/**
 * A support bot on the Vercel AI SDK (AI SDK 6 `ai.*` spans, as the Ivy layer captures them):
 * generateText with a tool that looks the order up in DynamoDB, then streamText for the reply.
 */

const SYSTEM = 'You are the support assistant for an online shop. Be concise. Use the tools to look orders up; never guess.';
const REWRITE = 'Rewrite support answers in a warm, short tone. Keep the facts.';
const QUESTIONS = [
  'Where is my order {id}? It was supposed to arrive on Monday.',
  'Can I still change the delivery address for {id}?',
  'My order {id} arrived damaged, what now?',
  'Has {id} shipped yet?',
];
const TOOLS = [
  JSON.stringify({
    type: 'function',
    name: 'getOrder',
    description: 'Look up an order by ID',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  }),
];

const common = (provider: string, model: string): Attributes => ({
  'otel.scope.name': 'ai',
  'ai.model.provider': provider,
  'ai.model.id': model,
  'ai.telemetry.functionId': 'support-answer',
  'ai.settings.maxRetries': 2,
});

const usage = (input: number, output: number): Attributes => ({
  'ai.usage.inputTokens': input,
  'ai.usage.outputTokens': output,
  'ai.usage.totalTokens': input + output,
  'gen_ai.usage.input_tokens': input,
  'gen_ai.usage.output_tokens': output,
});

const capped = (value: unknown) => payload(value).value;

interface ModelCall {
  step: number;
  messages: unknown[];
  ms: number;
  input: number;
  output: number;
  toolCall?: { toolCallId: string; toolName: string; input: string };
  text?: string;
  rateLimited?: boolean;
}

function doGenerate(inv: InvocationBuilder, call: ModelCall): void {
  const model = 'gpt-4o-mini';
  inv.nested('ai.generateText.doGenerate', 'INTERNAL', {
    ...common('openai.chat', model),
    'ai.operationId': 'ai.generateText.doGenerate',
    'ai.settings.temperature': 0.2,
    'ai.settings.maxOutputTokens': 400,
    'ai.prompt.messages': capped(call.messages),
    'ai.prompt.tools': TOOLS,
    'ai.prompt.toolChoice': '{"type":"auto"}',
    'gen_ai.system': 'openai.chat',
    'gen_ai.request.model': model,
    'gen_ai.request.temperature': 0.2,
    'gen_ai.request.max_tokens': 400,
  }, (span) => {
    inv.http('POST', 'https://api.openai.com/v1/chat/completions', {
      ms: call.ms,
      status: call.rateLimited ? 429 : 200,
      requestHeaders: { authorization: '[redacted]' },
      responseHeaders: { 'x-request-id': shortId('req') },
    });
    if (call.rateLimited) {
      throw new InvocationError('AI_APICallError', 'Rate limit reached for gpt-4o-mini in organization org-acme on tokens per min (TPM): Limit 200000, Used 199412, Requested 1290.');
    }
    const id = shortId('chatcmpl-', 10);
    Object.assign(span.attributes, {
      'ai.response.model': 'gpt-4o-mini-2024-07-18',
      'ai.response.id': id,
      'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
      'gen_ai.response.id': id,
      'ai.response.finishReason': call.toolCall ? 'tool-calls' : 'stop',
      'gen_ai.response.finish_reasons': [call.toolCall ? 'tool-calls' : 'stop'],
      ...(call.toolCall ? { 'ai.response.toolCalls': JSON.stringify([call.toolCall]) } : { 'ai.response.text': call.text ?? '' }),
      ...usage(call.input, call.output),
    });
  });
}

export const answerTicket: FunctionDef = {
  name: 'support-api-prod-answerTicket',
  region: 'eu-west-1',
  accountId: '123456789012',
  memoryMb: 1024,
  weight: 4,
  timeoutS: 30,
  faasTrigger: 'http',
  triggerSource: 'aws:apigatewayv2',
  kind: 'SERVER',
  memoryUsedMb: [130, 170],
  event() {
    const orderId = `ord_${randomInt(1000, 9999)}`;
    const body = { customerId: shortId('cus'), message: pick(QUESTIONS).replace('{id}', orderId) };
    return {
      event: {
        version: '2.0',
        routeKey: 'POST /support/messages',
        rawPath: '/support/messages',
        headers: { 'content-type': 'application/json', authorization: '[redacted]' },
        requestContext: { http: { method: 'POST', path: '/support/messages' }, requestId: uuid() },
        body: JSON.stringify(body),
        isBase64Encoded: false,
      },
      http: { method: 'POST', path: '/support/messages', route: '/support/messages' },
    };
  },
  run(ctx, event) {
    const { inv } = ctx;
    const { message } = JSON.parse((event as { body: string }).body) as { message: string };
    const orderId = /ord_\d+/.exec(message)![0];
    const order = { orderId, status: pick(['shipped', 'processing', 'delivered']), carrier: 'DHL', eta: '2026-11-19' };
    const answer = `Your order **${orderId}** is ${order.status} with DHL.\n\n- Expected delivery: Thursday, 19 November\n\nAnything else I can help with?`;
    const reply = `Hi! Good news: your order ${orderId} is ${order.status} and should arrive on Thursday.`;
    const toolCall = { toolCallId: shortId('call_', 8), toolName: 'getOrder', input: JSON.stringify({ orderId }) };
    const first = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text: message }] },
    ];
    const input1 = randomInt(780, 860);
    const input2 = input1 + randomInt(80, 110);
    const output2 = randomInt(35, 70);
    const rateLimited = chance(0.03 + ctx.errorBoost / 2);
    inv.log('info', `Answering ticket: ${message}`);

    const gen = inv.nested('ai.generateText', 'INTERNAL', {
      ...common('openai.chat', 'gpt-4o-mini'),
      'ai.operationId': 'ai.generateText',
      'ai.settings.temperature': 0.2,
      'ai.settings.maxOutputTokens': 400,
      'ai.prompt': JSON.stringify({ system: SYSTEM, prompt: message }),
    }, () => {
      doGenerate(inv, { step: 1, messages: first, ms: latency(600, 0.35), input: input1, output: 24, toolCall });
      inv.nested('ai.toolCall', 'INTERNAL', {
        'otel.scope.name': 'ai',
        'ai.operationId': 'ai.toolCall',
        'ai.toolCall.name': 'getOrder',
        'ai.toolCall.id': toolCall.toolCallId,
        'ai.toolCall.args': toolCall.input,
        'ai.toolCall.result': JSON.stringify(order),
      }, () => {
        inv.aws('DynamoDB', 'GetItem', {
          ms: latency(9, 0.4),
          attributes: { 'aws.dynamodb.table_names': ['orders-prod'] },
          request: { TableName: 'orders-prod', Key: { pk: { S: `ORDER#${orderId}` } } },
          response: { Item: { pk: { S: `ORDER#${orderId}` }, status: { S: order.status }, carrier: { S: 'DHL' } } },
        });
      });
      doGenerate(inv, {
        step: 2,
        messages: [
          ...first,
          { role: 'assistant', content: [{ type: 'tool-call', ...toolCall, input: { orderId } }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: toolCall.toolCallId, toolName: 'getOrder', output: { type: 'json', value: order } }] },
        ],
        ms: rateLimited ? latency(180, 0.3) : latency(950, 0.35),
        input: input2,
        output: output2,
        text: answer,
        rateLimited,
      });
    });
    Object.assign(gen.attributes, { 'ai.response.text': answer, 'ai.response.finishReason': 'stop', ...usage(input1 + input2, 24 + output2) });

    const ttft = latency(320, 0.35);
    const replyTokens = randomInt(30, 50);
    inv.nested('ai.streamText', 'INTERNAL', {
      ...common('anthropic.messages', 'claude-haiku-4-5'),
      'ai.operationId': 'ai.streamText',
      'ai.settings.temperature': 0.7,
      'ai.prompt': JSON.stringify({ system: REWRITE, prompt: answer }),
      'ai.response.text': reply,
      'ai.response.finishReason': 'stop',
      ...usage(164, replyTokens),
    }, () => {
      const stream = inv.nested('ai.streamText.doStream', 'INTERNAL', {
        ...common('anthropic.messages', 'claude-haiku-4-5'),
        'ai.operationId': 'ai.streamText.doStream',
        'ai.settings.temperature': 0.7,
        'ai.prompt.messages': JSON.stringify([
          { role: 'system', content: REWRITE },
          { role: 'user', content: [{ type: 'text', text: answer }] },
        ]),
        'gen_ai.system': 'anthropic.messages',
        'gen_ai.request.model': 'claude-haiku-4-5',
        'gen_ai.response.model': 'claude-haiku-4-5-20251001',
        'ai.response.msToFirstChunk': Math.round(ttft * 10) / 10,
        'ai.response.finishReason': 'stop',
        'gen_ai.response.finish_reasons': ['stop'],
        'ai.response.text': reply,
        ...usage(164, replyTokens),
      }, () => {
        inv.http('POST', 'https://api.anthropic.com/v1/messages', { ms: ttft + latency(160, 0.3), status: 200, requestHeaders: { 'x-api-key': '[redacted]' } });
      });
      stream.events.push({ timeMs: stream.startMs + ttft, name: 'ai.stream.firstChunk', attributes: { 'ai.response.msToFirstChunk': Math.round(ttft * 10) / 10 } });
    });
    return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply }) }, httpStatus: 200 };
  },
};
