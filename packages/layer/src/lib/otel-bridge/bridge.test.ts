import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_KEY } from './api.js';
import { attrs, resetGlobal, setupBridge } from './test-utils.js';

describe('OpenTelemetry bridge', () => {
  beforeEach(resetGlobal);
  afterEach(resetGlobal);

  it('turns active spans into Ivy spans, nested under each other and the invocation', async () => {
    const { invoke } = setupBridge();
    const otel = trace.getTracer('my-lib', '1.0.0');
    const { root, children, byName } = await invoke(() =>
      otel.startActiveSpan('outer', { kind: SpanKind.CLIENT, attributes: { 'app.n': 1, 'app.tags': ['a', 'b'] } }, async (outer) => {
        await otel.startActiveSpan('inner', async (inner) => {
          await new Promise((r) => setTimeout(r, 5));
          expect(trace.getActiveSpan()).toBe(inner);
          inner.addEvent('checkpoint', { step: 'x' });
          inner.end();
        });
        otel.startSpan('sibling', {}, context.active()).end();
        outer.setStatus({ code: SpanStatusCode.OK });
        outer.end();
      }),
    );
    expect(children).toHaveLength(3);
    const [outer] = byName('outer');
    const [inner] = byName('inner');
    const [sibling] = byName('sibling');
    expect(outer.parentSpanId).toBe(root.spanId);
    expect(outer.kind).toBe(3);
    expect(outer.traceId).toBe(root.traceId);
    expect(attrs(outer)).toMatchObject({ 'app.n': 1, 'app.tags': ['a', 'b'], 'otel.scope.name': 'my-lib' });
    expect(outer.status).toEqual({ code: 1 });
    expect(inner.parentSpanId).toBe(outer.spanId);
    expect(sibling.parentSpanId).toBe(outer.spanId);
    expect(inner.events).toMatchObject([{ name: 'checkpoint', attributes: [{ key: 'step', value: { stringValue: 'x' } }] }]);
    expect(BigInt(inner.endTimeUnixNano) - BigInt(inner.startTimeUnixNano)).toBeGreaterThan(4_000_000n);
  });

  it('records exceptions and error status', async () => {
    const { invoke } = setupBridge();
    const { children } = await invoke(() =>
      trace.getTracer('x').startActiveSpan('failing', (span) => {
        const err = new TypeError('model overloaded');
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.end();
      }),
    );
    expect(children[0].status).toEqual({ code: 2, message: 'model overloaded' });
    expect(attrs(children[0])['error.type']).toBe('TypeError');
    expect(attrs(children[0].events[0] as any)).toMatchObject({ 'exception.type': 'TypeError', 'exception.message': 'model overloaded' });
  });

  it('caps large attributes, redacts JSON keys and secret-named string attributes, keeps token counts', async () => {
    const { invoke } = setupBridge({ IVY_MAX_PAYLOAD_BYTES: '200' });
    const { children } = await invoke(() => {
      const span = trace.getTracer('x').startSpan('llm');
      span.setAttribute('ai.prompt', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-1' }));
      span.setAttribute('ai.response.text', 'x'.repeat(1000));
      span.setAttribute('ai.request.headers.x-api-key', 'sk-2');
      span.setAttribute('ai.usage.promptTokens', 812);
      span.setAttribute('ai.prompt.tools', ['{"name":"a","token":"t"}', 'y'.repeat(500), 'z', 'w', 'v']);
      span.end();
    });
    const a = attrs(children[0]);
    expect(a['ai.prompt']).toBe('{"messages":[{"role":"user","content":"hi"}],"apiKey":"[redacted]"}');
    expect(a['ai.response.text']).toMatch(/^x{200}…\[truncated 800 bytes\]$/);
    expect(a['ai.request.headers.x-api-key']).toBe('[redacted]');
    expect(a['ai.usage.promptTokens']).toBe(812);
    expect((a['ai.prompt.tools'] as string[])[0]).toBe('{"name":"a","token":"[redacted]"}');
    expect((a['ai.prompt.tools'] as string[])[1]).toMatch(/…\[truncated 300 bytes\]$/);
    expect(a['ivy.payload.truncated']).toBe(true);
  });

  it('nests the layer’s own spans (fetch, AWS SDK) under the active OTel span', async () => {
    const { tracer, invoke } = setupBridge();
    const { root, byName } = await invoke(async () => {
      tracer.startChild('DynamoDB.GetItem')!.endMs = Date.now();
      await trace.getTracer('x').startActiveSpan('tool', async (span) => {
        await Promise.resolve();
        tracer.startChild('POST api.openai.com')!.endMs = Date.now();
        span.end();
      });
    });
    expect(byName('DynamoDB.GetItem')[0].parentSpanId).toBe(root.spanId);
    expect(byName('POST api.openai.com')[0].parentSpanId).toBe(byName('tool')[0].spanId);
  });

  it('returns non-recording spans outside an invocation and leaves an existing provider alone', async () => {
    const { tracer } = setupBridge();
    const span = trace.getTracer('x').startSpan('init');
    expect(span.isRecording()).toBe(false);
    expect(tracer.active).toBeUndefined();

    resetGlobal();
    const theirs = { getTracer: () => ({}) };
    expect(trace.setGlobalTracerProvider(theirs as any)).toBe(true);
    setupBridge();
    const api = (globalThis as any)[GLOBAL_KEY];
    expect(api.trace.getDelegate()).toBe(theirs);
  });

  it('can be turned off', () => {
    setupBridge({ IVY_CAPTURE_OTEL: 'false' });
    expect((globalThis as any)[GLOBAL_KEY]).toBeUndefined();
  });

  it('registers a version every installed API copy accepts', async () => {
    setupBridge();
    expect((globalThis as any)[GLOBAL_KEY].version).toBe('1.10.0');
  });
});
