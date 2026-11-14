import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import type { OtlpAnyValue, OtlpSpan } from '../export/otlp.js';
import { signatureOf } from '../tracer/signature.js';
import { Tracer, type SpanBatch } from '../tracer/tracer.js';
import { patchSmithyClient } from './aws-sdk.js';
import { bedrockFromPath, StreamAssembler } from './bedrock.js';
import { startHttpSpan } from './http-span.js';

// The real AWS SDK client with a fake request handler: no Bedrock (or network) calls.
const require = createRequire(import.meta.url);
const clientPath = require.resolve('@aws-sdk/client-bedrock-runtime');
const sdkRequire = createRequire(clientPath);
const { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand, ConverseCommand, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const { EventStreamCodec } = sdkRequire('@smithy/core/event-streams');
const { toUtf8, fromUtf8 } = sdkRequire('@smithy/core/serde');

const plain = (v: OtlpAnyValue): unknown =>
  'stringValue' in v ? v.stringValue : 'boolValue' in v ? v.boolValue : 'intValue' in v ? Number(v.intValue) : 'doubleValue' in v ? v.doubleValue : v.arrayValue.values.map(plain);
const attrs = (s: OtlpSpan): Record<string, any> => Object.fromEntries(s.attributes.map((a) => [a.key, plain(a.value)]));

const MODEL_ID = 'eu.anthropic.claude-haiku-5-5-20261001-v1:0';
const anthropicRequest = {
  anthropic_version: 'bedrock-2023-05-31',
  system: 'You triage support tickets. Reply with JSON only.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'My order ord_8812 has not arrived.' }] }],
  max_tokens: 1024,
  temperature: 0,
};
const anthropicResponse = {
  id: 'msg_bdrk_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5-20261001',
  content: [{ type: 'text', text: '{"category":"shipping"}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 412, output_tokens: 38 },
};

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const event = (type: string, body: unknown) =>
  codec.encode({
    headers: {
      ':message-type': { type: 'string', value: 'event' },
      ':event-type': { type: 'string', value: type },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: Buffer.from(JSON.stringify(body)),
  });
const chunk = (body: unknown) => event('chunk', { bytes: Buffer.from(JSON.stringify(body)).toString('base64') });

type Reply = { status?: number; headers?: Record<string, string>; body: Buffer | Uint8Array[] };

// The smithy client is patched once per process, for one tracer.
const batches: SpanBatch[] = [];
const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://x' }), (b) => batches.push(b));
patchSmithyClient(tracer, sdkRequire('@smithy/core/client'));
let n = 0;

function setup() {
  const requests: { path: string; body: string }[] = [];
  let reply: Reply = { body: Buffer.from('{}') };
  const client = new BedrockRuntimeClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    maxAttempts: 1,
    requestHandler: {
      handle: async (request: any) => {
        requests.push({ path: request.path, body: typeof request.body === 'string' ? request.body : Buffer.from(request.body ?? '').toString() });
        const body = Array.isArray(reply.body) ? Readable.from(reply.body.map((b) => Buffer.from(b))) : Readable.from([reply.body]);
        return { response: { statusCode: reply.status ?? 200, headers: { 'x-amzn-requestid': 'req-bdrk-1', ...reply.headers }, body } };
      },
    },
  });
  const invoke = async (next: Reply, fn: () => Promise<unknown>) => {
    reply = next;
    const inv = tracer.startInvocation({}, { awsRequestId: `req-${++n}`, functionName: 'support-triageTicket' });
    await fn();
    const children = [...inv.children];
    tracer.endInvocation(inv, null, { ok: true });
    await new Promise((r) => setTimeout(r, 10));
    const spans = batches.filter((b) => b.requestId === `req-${n}`).flatMap((b) => b.spans);
    return { spans: spans.slice(1), raw: children };
  };
  return { client, invoke, requests };
}

describe('Bedrock Runtime instrumentation', () => {
  it('sets GenAI attributes on InvokeModel and keeps the bodies with their token counts', async () => {
    const { client, invoke } = setup();
    const { spans, raw } = await invoke(
      { headers: { 'content-type': 'application/json', 'x-amzn-bedrock-input-token-count': '412', 'x-amzn-bedrock-output-token-count': '38' }, body: Buffer.from(JSON.stringify(anthropicResponse)) },
      async () => {
        const out = await client.send(new InvokeModelCommand({ modelId: MODEL_ID, contentType: 'application/json', body: JSON.stringify(anthropicRequest) }));
        expect(JSON.parse(Buffer.from(out.body).toString())).toEqual(anthropicResponse);
      },
    );
    expect(spans).toHaveLength(1);
    const a = attrs(spans[0]);
    expect(spans[0].name).toBe('BedrockRuntime.InvokeModel');
    expect(a).toMatchObject({
      'rpc.service': 'BedrockRuntime',
      'rpc.method': 'InvokeModel',
      'gen_ai.system': 'aws.bedrock',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': MODEL_ID,
      'gen_ai.request.max_tokens': 1024,
      'gen_ai.request.temperature': 0,
      'gen_ai.usage.input_tokens': 412,
      'gen_ai.usage.output_tokens': 38,
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.response.model': 'claude-haiku-5-5-20261001',
      'cloud.region': 'eu-west-1',
    });
    expect(JSON.parse(a['ivy.payload.request'])).toMatchObject({ modelId: MODEL_ID, body: JSON.stringify(anthropicRequest) });
    expect(JSON.parse(a['ivy.payload.response']).body).toEqual(anthropicResponse);
    expect(signatureOf(raw[0])).toBe(`llm chat aws.bedrock ${MODEL_ID}`);
  });

  it('reads Converse usage and stop reason', async () => {
    const { client, invoke } = setup();
    const response = { output: { message: { role: 'assistant', content: [{ text: 'It shipped.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 655, outputTokens: 61, totalTokens: 716 }, metrics: { latencyMs: 803 } };
    const { spans } = await invoke({ headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(response)) }, () =>
      client.send(new ConverseCommand({ modelId: 'eu.amazon.nova-lite-v1:0', messages: [{ role: 'user', content: [{ text: 'Hi' }] }], inferenceConfig: { maxTokens: 512 } })),
    );
    const a = attrs(spans[0]);
    expect(a).toMatchObject({ 'gen_ai.request.model': 'eu.amazon.nova-lite-v1:0', 'gen_ai.request.max_tokens': 512, 'gen_ai.usage.input_tokens': 655, 'gen_ai.usage.output_tokens': 61, 'gen_ai.response.finish_reasons': ['end_turn'] });
    expect(JSON.parse(a['ivy.payload.request']).inferenceConfig).toEqual({ maxTokens: 512 });
    expect(JSON.parse(a['ivy.payload.response'])).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 655, outputTokens: 61 } });
  });

  it('assembles InvokeModelWithResponseStream (Anthropic events): usage, time to first chunk, the response', async () => {
    const { client, invoke } = setup();
    const events = [
      chunk({ type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-5-5-20261001', usage: { input_tokens: 40, output_tokens: 1 } } }),
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      chunk({ type: 'content_block_stop', index: 0 }),
      chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'getOrder', input: {} } }),
      chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"orderId":' } }),
      chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ord_8812"}' } }),
      chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      chunk({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 40, outputTokenCount: 9, invocationLatency: 500, firstByteLatency: 300 } }),
    ];
    let text = '';
    const { spans } = await invoke({ headers: { 'content-type': 'application/vnd.amazon.eventstream' }, body: events }, async () => {
      const out = await client.send(new InvokeModelWithResponseStreamCommand({ modelId: MODEL_ID, body: JSON.stringify(anthropicRequest) }));
      for await (const e of out.body) {
        const c = JSON.parse(Buffer.from(e.chunk.bytes).toString());
        if (c.delta?.text) text += c.delta.text;
      }
    });
    expect(text).toBe('Hello');
    const a = attrs(spans[0]);
    expect(a).toMatchObject({ 'gen_ai.usage.input_tokens': 40, 'gen_ai.usage.output_tokens': 9, 'gen_ai.response.finish_reasons': ['tool_use'], 'gen_ai.response.model': 'claude-haiku-5-5-20261001' });
    expect(a['gen_ai.response.time_to_first_chunk']).toBeGreaterThanOrEqual(0);
    expect(a['ivy.incomplete']).toBeUndefined();
    expect(JSON.parse(a['ivy.payload.response'])).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'toolu_1', name: 'getOrder', input: { orderId: 'ord_8812' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 40, output_tokens: 9 },
    });
  });

  it('assembles ConverseStream: text, stop reason and usage from the metadata event', async () => {
    const { client, invoke } = setup();
    const events = [
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'It ' } }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'shipped.' } }),
      event('contentBlockStop', { contentBlockIndex: 0 }),
      event('messageStop', { stopReason: 'end_turn' }),
      event('metadata', { usage: { inputTokens: 58, outputTokens: 29, totalTokens: 87 }, metrics: { latencyMs: 402 } }),
    ];
    const { spans } = await invoke({ headers: { 'content-type': 'application/vnd.amazon.eventstream' }, body: events }, async () => {
      const out = await client.send(new ConverseStreamCommand({ modelId: 'eu.amazon.nova-lite-v1:0', messages: [{ role: 'user', content: [{ text: 'Hi' }] }] }));
      for await (const _ of out.stream) {
        // read it all
      }
    });
    const a = attrs(spans[0]);
    expect(a).toMatchObject({ 'gen_ai.usage.input_tokens': 58, 'gen_ai.usage.output_tokens': 29, 'gen_ai.response.finish_reasons': ['end_turn'] });
    expect(a['gen_ai.response.time_to_first_chunk']).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(a['ivy.payload.response'])).toEqual({
      output: { message: { role: 'assistant', content: [{ text: 'It shipped.' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 58, outputTokens: 29 },
      metrics: { latencyMs: 402 },
    });
  });

  it('collapses repeated calls to one model and sums their tokens', async () => {
    const { client, invoke } = setup();
    const { spans } = await invoke({ headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(anthropicResponse)) }, async () => {
      for (let i = 0; i < 60; i++) await client.send(new InvokeModelCommand({ modelId: MODEL_ID, body: JSON.stringify(anthropicRequest) }));
    });
    const summary = spans.find((s) => /× \d+$/.test(s.name))!;
    const a = attrs(summary);
    expect(summary.name).toBe(`BedrockRuntime.InvokeModel × ${a['ivy.collapsed.count']}`);
    expect(a['ivy.collapsed.input_tokens']).toBe(412 * a['ivy.collapsed.count']);
    expect(a['ivy.collapsed.output_tokens']).toBe(38 * a['ivy.collapsed.count']);
    expect(a).toMatchObject({ 'gen_ai.system': 'aws.bedrock', 'gen_ai.request.model': MODEL_ID, 'rpc.method': 'InvokeModel' });
  });

  it('records errors', async () => {
    const { client, invoke } = setup();
    const { spans } = await invoke(
      { status: 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' }, body: Buffer.from(JSON.stringify({ message: 'max_tokens: must be at most 8192' })) },
      () => client.send(new InvokeModelCommand({ modelId: MODEL_ID, body: JSON.stringify(anthropicRequest) })).catch(() => undefined),
    );
    expect(spans[0].status.code).toBe(2);
    expect(attrs(spans[0])['gen_ai.request.model']).toBe(MODEL_ID);
  });
});

describe('Bedrock Runtime over plain HTTP (SDK copies the layer could not patch)', () => {
  it('names the span and sets GenAI attributes from the URL, then usage from the response', () => {
    const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://x' }), () => {});
    tracer.startInvocation({}, { awsRequestId: 'r', functionName: 'f' });
    const span = startHttpSpan(tracer, { method: 'POST', protocol: 'https:', host: 'bedrock-runtime.eu-west-1.amazonaws.com', path: `/model/${encodeURIComponent(MODEL_ID)}/invoke` })!;
    expect(span.name).toBe('BedrockRuntime.InvokeModel');
    expect(span.attributes).toMatchObject({ 'rpc.service': 'BedrockRuntime', 'rpc.method': 'InvokeModel', 'gen_ai.system': 'aws.bedrock', 'gen_ai.request.model': MODEL_ID });
    expect(bedrockFromPath('bedrock-runtime.us-east-1.amazonaws.com', '/model/amazon.nova-lite-v1%3A0/converse-stream')).toEqual({ operation: 'ConverseStream', modelId: 'amazon.nova-lite-v1:0' });
    expect(bedrockFromPath('bedrock.us-east-1.amazonaws.com', '/foundation-models')).toBeUndefined();
  });
});

describe('StreamAssembler', () => {
  it('concatenates other families (Llama) and takes the invocation metrics', () => {
    const a = new StreamAssembler();
    const c = (body: unknown) => ({ chunk: { bytes: Buffer.from(JSON.stringify(body)) } });
    a.add(c({ generation: 'Hi', prompt_token_count: 12, generation_token_count: 1 }));
    a.add(c({ generation: ' there', generation_token_count: 1, stop_reason: 'stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 12, outputTokenCount: 2 } }));
    expect(a.result()).toMatchObject({ content: [{ type: 'text', text: 'Hi there' }], stop_reason: 'stop', usage: { input_tokens: 12, output_tokens: 2 } });
  });
});
