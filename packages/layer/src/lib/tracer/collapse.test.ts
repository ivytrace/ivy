import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { chunkSpans } from '../export/chunks.js';
import type { OtlpAnyValue, OtlpSpan } from '../export/otlp.js';
import { bodyTokens, isLlmCall, routeTemplate } from './signature.js';
import { recordError, type Span } from './span.js';
import { Tracer, type SpanBatch } from './tracer.js';

const plain = (v: OtlpAnyValue): unknown =>
  'stringValue' in v ? v.stringValue : 'boolValue' in v ? v.boolValue : 'intValue' in v ? Number(v.intValue) : 'doubleValue' in v ? v.doubleValue : v.arrayValue.values.map(plain);
const attrs = (s: OtlpSpan): Record<string, any> => Object.fromEntries(s.attributes.map((a) => [a.key, plain(a.value)]));

function setup(env: Record<string, string> = {}) {
  const batches: SpanBatch[] = [];
  const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://x', ...env }), (b) => batches.push(b));
  const inv = tracer.startInvocation({ hello: 'event' }, { awsRequestId: 'req-1', functionName: 'importer' });
  let t = inv.root.startMs;
  /** A finished call of `ms` duration, back to back with the previous one. */
  const call = (name: string, attributes: Record<string, any>, ms = 1, opts: { error?: boolean; payload?: unknown; parent?: Span } = {}) => {
    const s = tracer.startChild(name);
    if (!s) return undefined;
    Object.assign(s.attributes, attributes);
    if (opts.parent) s.parentSpanId = opts.parent.spanId;
    s.startMs = t;
    t += ms;
    s.endMs = t;
    if (opts.error) recordError(s, new Error('ConditionalCheckFailed'), t);
    if (opts.payload !== undefined) s.payloads.push({ key: 'ivy.payload.request', value: opts.payload });
    return s;
  };
  const finish = async () => {
    tracer.endInvocation(inv, null, { ok: true });
    await new Promise((r) => setImmediate(r));
    const spans = batches.flatMap((b) => b.spans);
    return { batches, root: spans[0], children: spans.slice(1), spans };
  };
  return { tracer, inv, call, finish };
}

const ddb = (table = 'orders') => ({ 'rpc.system': 'aws-api', 'rpc.service': 'DynamoDB', 'rpc.method': 'PutItem', 'aws.dynamodb.table_names': [table] });

describe('collapsing repetitive calls', () => {
  it('keeps the first and slowest calls and every error, and summarises the rest', async () => {
    const { call, finish } = setup();
    for (let i = 0; i < 3000; i++) call('DynamoDB.PutItem', ddb(), i === 1500 ? 90 : i === 2000 ? 80 : i === 10 ? 70 : 2, { error: i === 7 || i === 2999 });
    const { root, children } = await finish();
    const summaries = children.filter((s) => attrs(s)['ivy.collapsed.count'] !== undefined);
    expect(summaries).toHaveLength(1);
    const sum = attrs(summaries[0]);
    // 3000 calls: 10 first, 3 slowest, 2 errors in full.
    expect(children).toHaveLength(16);
    expect(summaries[0].name).toBe('DynamoDB.PutItem × 2,985');
    expect(sum).toMatchObject({
      'ivy.collapsed.count': 2985,
      'ivy.collapsed.kept': 15,
      'ivy.collapsed.errors': 2,
      'ivy.collapsed.duration_max_ms': 2,
      'ivy.collapsed.signature': 'DynamoDB.PutItem orders',
      'rpc.service': 'DynamoDB',
      'aws.dynamodb.table_names': ['orders'],
    });
    expect(sum['ivy.collapsed.duration_total_ms']).toBeCloseTo(2985 * 2, 3);
    expect(sum['ivy.payload.request']).toBeUndefined();
    const errors = children.filter((s) => s.status.code === 2);
    expect(errors).toHaveLength(2);
    const durations = children.filter((s) => s !== summaries[0] && s.status.code !== 2).map((s) => (Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6));
    expect(durations.filter((d) => d >= 70)).toHaveLength(3);
    // The bar covers the whole collapsed run.
    expect(BigInt(summaries[0].endTimeUnixNano) - BigInt(summaries[0].startTimeUnixNano)).toBeGreaterThan(5900n * 1_000_000n);
    expect(attrs(root)['ivy.collapsed_calls']).toBe(2985);
    expect(attrs(root)['ivy.dropped_spans']).toBeUndefined();
  });

  it('leaves runs at or below the threshold alone and groups by target', async () => {
    const { call, finish } = setup();
    for (let i = 0; i < 50; i++) call('DynamoDB.PutItem', ddb('orders'));
    for (let i = 0; i < 60; i++) call('DynamoDB.PutItem', ddb('customers'));
    const { children } = await finish();
    const summaries = children.filter((s) => attrs(s)['ivy.collapsed.count'] !== undefined);
    expect(summaries.map((s) => attrs(s)['ivy.collapsed.signature'])).toEqual(['DynamoDB.PutItem customers']);
    expect(children.filter((s) => attrs(s)['aws.dynamodb.table_names']?.[0] === 'orders' && !s.name.includes('×'))).toHaveLength(50);
  });

  it('honours IVY_COLLAPSE_* settings and can be turned off', async () => {
    const a = setup({ IVY_COLLAPSE_THRESHOLD: '5', IVY_COLLAPSE_KEEP: '2', IVY_COLLAPSE_KEEP_SLOWEST: '1' });
    for (let i = 0; i < 20; i++) a.call('GET api.example.com', { 'http.request.method': 'GET', 'server.address': 'api.example.com', 'url.full': `https://api.example.com/users/${1000 + i}?x=1` });
    const { children } = await a.finish();
    expect(children).toHaveLength(4);
    expect(attrs(children[3])['ivy.collapsed.signature']).toBe('GET api.example.com /users/{id}');
    expect(children[3].name).toBe('GET api.example.com × 17');

    const off = setup({ IVY_COLLAPSE_THRESHOLD: '0' });
    for (let i = 0; i < 200; i++) off.call('DynamoDB.PutItem', ddb());
    expect((await off.finish()).children).toHaveLength(200);
  });

  it('collapses while the invocation runs, so long runs never hit the span limit', async () => {
    const { call, finish } = setup({ IVY_MAX_SPANS: '100' });
    for (let i = 0; i < 5000; i++) call('DynamoDB.PutItem', ddb());
    const { root, children } = await finish();
    expect(children.length).toBeLessThan(20);
    expect(attrs(children.find((s) => s.name.includes('×'))!)['ivy.collapsed.count']).toBe(5000 - 13);
    expect(attrs(root)['ivy.dropped_spans']).toBeUndefined();
  });

  it('sums tokens of collapsed LLM calls, from bridge attributes and from plain HTTP response bodies', async () => {
    const bridge = setup();
    for (let i = 0; i < 80; i++) {
      bridge.call('ai.generateText', { 'ai.operationId': 'ai.generateText', 'ai.model.provider': 'openai.chat', 'ai.model.id': 'gpt-4o-mini', 'ai.usage.inputTokens': 100, 'ai.usage.outputTokens': 10 });
    }
    const b = await bridge.finish();
    const sb = attrs(b.children.find((s) => s.name.includes('×'))!);
    expect(sb['ivy.collapsed.count']).toBe(67);
    expect(sb['ivy.collapsed.input_tokens']).toBe(6700);
    expect(sb['ivy.collapsed.output_tokens']).toBe(670);
    expect(sb['ai.model.id']).toBe('gpt-4o-mini');

    const http = setup();
    for (let i = 0; i < 60; i++) {
      const s = http.call('POST api.openai.com', { 'http.request.method': 'POST', 'server.address': 'api.openai.com', 'url.full': 'https://api.openai.com/v1/chat/completions' })!;
      s.finalize = () => s.payloads.push({ key: 'ivy.payload.response', value: '{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50}}', rawContentType: 'application/json' });
    }
    const h = await http.finish();
    const sh = attrs(h.children.find((s) => s.name.includes('×'))!);
    expect(sh['ivy.collapsed.count']).toBe(47);
    expect(sh['ivy.collapsed.input_tokens']).toBe(47_000);
    expect(sh['ivy.collapsed.output_tokens']).toBe(2350);
  });

  it('collapses a repeated call together with its nested spans', async () => {
    const { call, finish } = setup();
    for (let i = 0; i < 60; i++) {
      const tool = call('ai.toolCall', { 'ai.toolCall.name': 'lookup' }, 3)!;
      call('DynamoDB.GetItem', { ...ddb(), 'rpc.method': 'GetItem' }, 1, { parent: tool });
    }
    const { children } = await finish();
    const summary = children.find((s) => s.name.startsWith('ai.toolCall ×'))!;
    expect(attrs(summary)['ivy.collapsed.count']).toBe(47);
    expect(attrs(summary)['ivy.collapsed.spans']).toBe(94);
    expect(children).toHaveLength(13 * 2 + 1);
    const ids = new Set(children.map((s) => s.spanId));
    expect(children.every((s) => !s.parentSpanId || ids.has(s.parentSpanId) || s.parentSpanId === children[0].parentSpanId)).toBe(true);
  });
});

describe('span limit', () => {
  it('keeps errors, then the root’s direct children by duration, and reports what it dropped', async () => {
    const { call, finish } = setup({ IVY_MAX_SPANS: '100' });
    const parent = call('batch', {}, 500)!;
    for (let i = 0; i < 300; i++) call(`step-${i}`, {}, i % 7, { error: i === 299, parent: i % 2 ? parent : undefined });
    const { root, children } = await finish();
    expect(children).toHaveLength(100);
    expect(children.some((s) => s.name === 'step-299' && s.status.code === 2)).toBe(true);
    expect(children.some((s) => s.name === 'batch')).toBe(true);
    expect(attrs(root)['ivy.dropped_spans']).toBe(201);
    expect(attrs(root)['ivy.dropped_spans.reason']).toBe('span limit');
  });
});

describe('payload budget', () => {
  it('spends the budget on the root, then errors, then the slowest, and trims the rest', async () => {
    const { call, finish } = setup({ IVY_MAX_INVOCATION_PAYLOAD_BYTES: '20000', IVY_COLLAPSE_THRESHOLD: '0' });
    const body = { data: 'x'.repeat(3000) };
    for (let i = 0; i < 20; i++) call(`call-${i}`, {}, i === 15 ? 50 : 1, { payload: body, error: i === 18 });
    const { root, children } = await finish();
    const has = (name: string) => attrs(children.find((s) => s.name === name)!)['ivy.payload.request'] !== undefined;
    expect(attrs(root)['ivy.payload.request']).toBeDefined();
    expect(has('call-18')).toBe(true);
    expect(has('call-15')).toBe(true);
    expect(has('call-19')).toBe(false);
    const kept = children.filter((s) => attrs(s)['ivy.payload.request'] !== undefined);
    const trimmed = children.filter((s) => attrs(s)['ivy.payload.trimmed'] === true);
    expect(kept.length + trimmed.length).toBe(20);
    expect(kept.reduce((n, s) => n + String(attrs(s)['ivy.payload.request']).length, 0)).toBeLessThanOrEqual(20000);
    expect(attrs(root)['ivy.trimmed_payloads']).toBe(trimmed.length);
    expect(attrs(root)['ivy.trimmed_payload_bytes']).toBeGreaterThan(0);
  });
});

describe('export chunks', () => {
  it('sends the invocation span alone first, then chunks within the span and byte limits', async () => {
    const { call, finish } = setup({ IVY_EXPORT_CHUNK_SPANS: '100', IVY_EXPORT_CHUNK_BYTES: '20000', IVY_COLLAPSE_THRESHOLD: '0' });
    for (let i = 0; i < 250; i++) call(`call-${i}`, {}, 1, { payload: { i, pad: 'y'.repeat(100) } });
    const { batches } = await finish();
    expect(batches[0].spans).toHaveLength(1);
    expect(batches[0].final).toBe(false);
    expect(batches.at(-1)!.final).toBe(true);
    expect(batches.slice(1).every((b) => b.spans.length <= 100 && JSON.stringify(b.spans).length <= 20000)).toBe(true);
    expect(batches.slice(1).reduce((n, b) => n + b.spans.length, 0)).toBe(250);
  });

  it('trims the payloads of a span larger than a chunk instead of dropping it', () => {
    const big: OtlpSpan = {
      traceId: 't',
      spanId: 's',
      name: 'POST api.openai.com',
      kind: 3,
      startTimeUnixNano: '0',
      endTimeUnixNano: '1',
      attributes: [
        { key: 'ivy.payload.request', value: { stringValue: 'a'.repeat(30_000) } },
        { key: 'url.full', value: { stringValue: 'https://api.openai.com/v1/chat/completions' } },
      ],
      events: [],
      status: { code: 0 },
    };
    const chunks = chunkSpans([big], { spans: 10, bytes: 16 * 1024 });
    expect(chunks).toHaveLength(1);
    expect(attrs(chunks[0][0])).toEqual({ 'url.full': 'https://api.openai.com/v1/chat/completions', 'ivy.payload.trimmed': true });
  });
});

describe('signature helpers', () => {
  it('templates IDs in paths and reads tokens from provider bodies', () => {
    expect(routeTemplate('/users/42/orders/3f2a9c1e-1b2c-4d5e-8f90-123456789abc')).toBe('/users/{id}/orders/{id}');
    expect(routeTemplate('/v1/chat/completions')).toBe('/v1/chat/completions');
    expect(bodyTokens('{"usage":{"input_tokens":12,"output_tokens":3}}')).toEqual({ input: 12, output: 3 });
    expect(isLlmCall('api.anthropic.com', 'https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isLlmCall('llm-gateway.internal', 'http://llm-gateway.internal/v1/chat/completions')).toBe(true);
    expect(isLlmCall('generativelanguage.googleapis.com', undefined)).toBe(true);
    expect(isLlmCall('api.example.com', 'https://api.example.com/v1/orders')).toBe(false);
    expect(bodyTokens('data: {"usage":{"output_tokens":1}}\n\ndata: {"usage":{"output_tokens":9}}')).toEqual({ input: undefined, output: 9 });
  });
});
