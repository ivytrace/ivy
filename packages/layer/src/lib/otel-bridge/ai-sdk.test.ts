import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerCustomer, REPLY, supportModels } from '../../../example/ai/scenario.mjs';
import { attrs, resetGlobal, setupBridge } from './test-utils.js';

/** Real AI SDK packages with their mock models: no LLM API calls. */
async function run(version: 6 | 7) {
  const { tracer, invoke } = setupBridge();
  const ai: any = version === 6 ? await import('ai-v6') : await import('ai');
  const test: any = version === 6 ? await import('ai-v6/test') : await import('ai/test');
  let telemetry: Record<string, unknown> = { experimental_telemetry: { isEnabled: true, functionId: 'support-reply' } };
  if (version === 7) {
    const { OpenTelemetry } = await import('@ai-sdk/otel');
    ai.registerTelemetry(new OpenTelemetry());
    telemetry = { telemetry: { functionId: 'support-reply' } };
  }
  const models = supportModels({ Mock: version === 6 ? test.MockLanguageModelV3 : test.MockLanguageModelV4, simulateReadableStream: ai.simulateReadableStream });
  let result: { answer: string; reply: string } | undefined;
  const spans = await invoke(async () => {
    result = await answerCustomer({
      ai,
      models,
      telemetry,
      lookupOrder: async (orderId) => {
        const span = tracer.startChild('DynamoDB.GetItem')!;
        span.attributes['rpc.system'] = 'aws-api';
        await new Promise((r) => setTimeout(r, 3));
        span.endMs = Date.now();
        return { orderId, status: 'shipped', carrier: 'DHL' };
      },
    });
  });
  return { ...spans, result };
}

describe('Vercel AI SDK 6 (experimental_telemetry)', () => {
  let r: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    resetGlobal();
    r = await run(6);
  });
  afterAll(resetGlobal);

  it('runs unchanged', () => {
    expect(r.result?.answer).toBe(REPLY);
    expect(r.result?.reply).toContain('on its way');
  });

  it('captures generateText with its steps and the tool call, nested', () => {
    if (process.env.IVY_DUMP) writeFileSync(process.env.IVY_DUMP + '-' + r.root.traceId, JSON.stringify(r.children.map((s) => ({ name: s.name, id: s.spanId, parent: s.parentSpanId, attrs: attrs(s), events: s.events })), null, 2));
    const [gen] = r.byName('ai.generateText');
    const steps = r.byName('ai.generateText.doGenerate');
    const [tool] = r.byName('ai.toolCall');
    const [ddb] = r.byName('DynamoDB.GetItem');
    expect(gen.parentSpanId).toBe(r.root.spanId);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.parentSpanId === gen.spanId)).toBe(true);
    expect(tool.parentSpanId).toBe(gen.spanId);
    expect(ddb.parentSpanId).toBe(tool.spanId);
    expect(attrs(gen)).toMatchObject({
      'ai.model.id': 'gpt-4o-mini',
      'ai.model.provider': 'openai.chat',
      'ai.response.text': REPLY,
      'ai.usage.inputTokens': 1713,
      'ai.usage.outputTokens': 65,
      'ai.settings.maxOutputTokens': 400,
      'ai.telemetry.functionId': 'support-reply',
    });
    expect(attrs(steps[0])).toMatchObject({ 'gen_ai.system': 'openai.chat', 'gen_ai.request.temperature': 0.2, 'gen_ai.usage.input_tokens': 812 });
    expect(JSON.parse(attrs(steps[0])['ai.prompt.messages'] as string)[0]).toMatchObject({ role: 'system' });
    expect(attrs(tool)).toMatchObject({ 'ai.toolCall.name': 'getOrder', 'ai.toolCall.args': '{"orderId":"ord_8812"}' });
    expect(JSON.parse(attrs(tool)['ai.toolCall.result'] as string)).toMatchObject({ status: 'shipped' });
  });

  it('captures streamText with time to first chunk', () => {
    const [stream] = r.byName('ai.streamText');
    const [doStream] = r.byName('ai.streamText.doStream');
    expect(doStream.parentSpanId).toBe(stream.spanId);
    expect(attrs(doStream)['ai.response.msToFirstChunk']).toBeGreaterThan(0);
    expect(doStream.events.map((e) => e.name)).toContain('ai.stream.firstChunk');
    expect(attrs(stream)).toMatchObject({ 'ai.model.provider': 'anthropic.messages', 'ai.usage.outputTokens': 38 });
  });
});

describe('Vercel AI SDK 7 with @ai-sdk/otel', () => {
  let r: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    resetGlobal();
    r = await run(7);
  });
  afterAll(resetGlobal);

  it('runs unchanged', () => {
    expect(r.result?.answer).toBe(REPLY);
  });

  it('captures GenAI semantic-convention spans, nested', () => {
    if (process.env.IVY_DUMP) writeFileSync(process.env.IVY_DUMP + '-' + r.root.traceId, JSON.stringify(r.children.map((s) => ({ name: s.name, id: s.spanId, parent: s.parentSpanId, attrs: attrs(s), events: s.events })), null, 2));
    const [agent] = r.byName('invoke_agent gpt-4o-mini');
    const steps = r.byName(/^step \d/);
    const chats = r.byName('chat gpt-4o-mini');
    const [tool] = r.byName('execute_tool getOrder');
    const [ddb] = r.byName('DynamoDB.GetItem');
    expect(agent.parentSpanId).toBe(r.root.spanId);
    expect(chats).toHaveLength(2);
    expect(tool.parentSpanId).toBe(steps[0].spanId);
    expect(ddb.parentSpanId).toBe(tool.spanId);
    expect(attrs(chats[0])).toMatchObject({ 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.usage.input_tokens': 812 });
    expect(attrs(tool)).toMatchObject({ 'gen_ai.tool.name': 'getOrder' });
    const [chatStream] = r.byName('chat claude-haiku-4-5');
    expect(attrs(chatStream)['gen_ai.client.operation.time_to_first_chunk']).toBeGreaterThan(0.03);
  });
});
