import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvocationSpan } from './invocation-span.js';
import { attrs, resetGlobal, setupBridge } from './test-utils.js';

describe('trace.getActiveSpan() in a handler', () => {
  beforeEach(resetGlobal);
  afterEach(resetGlobal);

  it('returns the invocation span, whose attributes land on the invocation', async () => {
    const { invoke } = setupBridge();
    let span: Span | undefined;
    const { root, children } = await invoke(async () => {
      span = trace.getActiveSpan();
      span?.setAttribute('user.id', 'u-42');
      await Promise.resolve();
      trace.getActiveSpan()?.setAttributes({ 'tenant.id': 'acme', 'feature.flag': true, 'cart.items': 3, skip: undefined });
      trace.getActiveSpan()?.setAttribute('tags', ['a', 'b']);
      span?.end();
      span?.updateName('renamed');
    });
    expect(span).toBeInstanceOf(InvocationSpan);
    expect(span!.isRecording()).toBe(false);
    expect(span!.spanContext()).toEqual({ traceId: root.traceId, spanId: root.spanId, traceFlags: 1 });
    expect(root.name).toBe('support-bot');
    expect(children).toHaveLength(0);
    const a = attrs(root);
    expect(a).toMatchObject({ 'user.id': 'u-42', 'tenant.id': 'acme', 'feature.flag': true, 'cart.items': 3, tags: ['a', 'b'] });
    expect('skip' in a).toBe(false);
    expect(a['ivy.invocation']).toBe(true);
  });

  it('is recording while the invocation runs', async () => {
    const { invoke } = setupBridge();
    let recording: boolean | undefined;
    await invoke(() => {
      recording = trace.getActiveSpan()?.isRecording();
    });
    expect(recording).toBe(true);
  });

  it('applies redaction and caps to custom attributes and events only', async () => {
    const { invoke } = setupBridge({ IVY_MAX_PAYLOAD_BYTES: '100' });
    const { root } = await invoke(() => {
      const span = trace.getActiveSpan()!;
      span.setAttribute('auth.token', 'secret-value');
      span.setAttribute('order', JSON.stringify({ id: 'o-1', password: 'hunter2' }));
      span.setAttribute('note', 'x'.repeat(500));
      span.setAttribute('usage.inputTokens', 812);
      span.addEvent('checkout.step', { detail: 'y'.repeat(500) });
    });
    const a = attrs(root);
    expect(a['auth.token']).toBe('[redacted]');
    expect(a.order).toBe('{"id":"o-1","password":"[redacted]"}');
    expect(a.note).toMatch(/^x{100}…\[truncated 400 bytes\]$/);
    expect(a['usage.inputTokens']).toBe(812);
    expect(a['ivy.payload.truncated']).toBe(true);
    const event = root.events.find((e) => e.name === 'checkout.step')!;
    expect(String(attrs(event as any).detail)).toMatch(/…\[truncated 400 bytes\]$/);
    expect(a['ivy.payload.request']).toBe('{}');
  });

  it('redacts secret-named arrays and event fields', async () => {
    const { invoke } = setupBridge({ IVY_MAX_PAYLOAD_BYTES: '100' });
    const { root } = await invoke(() => {
      const span = trace.getActiveSpan()!;
      span.setAttribute('auth.token', ['secret-1', 'secret-2']);
      span.setAttribute('usage.tokens', [12, 34]);
      span.addEvent('checkout', { password: 'hunter2', 'session.token': ['s-1'], step: 'pay', lines: ['z'.repeat(500)] });
    });
    const a = attrs(root);
    expect(a['auth.token']).toBe('[redacted]');
    expect(a['usage.tokens']).toEqual([12, 34]);
    const event = attrs(root.events.find((e) => e.name === 'checkout') as any);
    expect(event).toMatchObject({ password: '[redacted]', 'session.token': '[redacted]', step: 'pay' });
    expect(String((event.lines as string[])[0])).toMatch(/…\[truncated 400 bytes\]$/);
  });

  it('protects the layer’s own attributes', async () => {
    const { invoke } = setupBridge();
    const { root } = await invoke(() =>
      trace.getActiveSpan()?.setAttributes({
        'faas.coldstart': false,
        'ivy.invocation': false,
        'ivy.trigger.source': 'x',
        'cloud.resource_id': 'x',
        'aws.region': 'x',
        'http.response.status_code': 500,
        'error.type': 'x',
        'ivyx.ok': 1,
      }),
    );
    const a = attrs(root);
    expect(a['faas.coldstart']).toBe(true);
    expect(a['ivy.invocation']).toBe(true);
    expect(a['ivy.trigger.source']).toBe('aws:lambda');
    expect(a['ivyx.ok']).toBe(1);
    for (const key of ['cloud.resource_id', 'aws.region', 'http.response.status_code', 'error.type']) expect(key in a).toBe(false);
    expect(root.status).toEqual({ code: 0 });
  });

  it('records events and exceptions, and setStatus(ERROR) fails the invocation', async () => {
    const { invoke } = setupBridge();
    const { root } = await invoke(() => {
      const span = trace.getActiveSpan()!;
      span.addEvent('cache.miss', { key: 'k' });
      span.recordException(new TypeError('card declined'));
      span.setStatus({ code: SpanStatusCode.OK });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'payment failed' });
      return { statusCode: 200 };
    });
    expect(root.status).toEqual({ code: 2, message: 'payment failed' });
    expect(root.events.map((e) => e.name)).toEqual(['cache.miss', 'exception']);
    expect(attrs(root.events[1] as any)).toMatchObject({ 'exception.type': 'TypeError', 'exception.message': 'card declined' });
  });

  it('is undefined outside an invocation', async () => {
    const { invoke } = setupBridge();
    expect(trace.getActiveSpan()).toBeUndefined();
    await invoke(() => {});
    expect(trace.getActiveSpan()).toBeUndefined();
    let underRoot: Span | undefined | null = null;
    await invoke(() => {
      underRoot = context.with(ROOT_CONTEXT, () => trace.getActiveSpan());
    });
    expect(underRoot).toBeUndefined();
  });

  it('gives way to an active library span, which still nests under the invocation', async () => {
    const { tracer, invoke } = setupBridge();
    const otel = trace.getTracer('my-lib');
    let invocation: Span | undefined;
    let activeInOuter: Span | undefined;
    let outerSpan: Span | undefined;
    let activeAfter: Span | undefined;
    const { root, byName } = await invoke(async () => {
      invocation = trace.getActiveSpan();
      await otel.startActiveSpan('outer', async (outer) => {
        outerSpan = outer;
        activeInOuter = trace.getActiveSpan();
        await otel.startActiveSpan('inner', async (inner) => {
          await Promise.resolve();
          tracer.startChild('GET example.com')!.endMs = Date.now();
          inner.end();
        });
        outer.end();
      });
      otel.startSpan('explicit', {}, trace.setSpan(context.active(), invocation!)).end();
      tracer.startChild('DynamoDB.GetItem')!.endMs = Date.now();
      activeAfter = trace.getActiveSpan();
      trace.getActiveSpan()?.setAttribute('after', 1);
    });
    expect(invocation).toBeInstanceOf(InvocationSpan);
    expect(activeInOuter).toBe(outerSpan);
    expect(activeAfter).toBe(invocation);
    expect(byName('outer')[0].parentSpanId).toBe(root.spanId);
    expect(byName('inner')[0].parentSpanId).toBe(byName('outer')[0].spanId);
    expect(byName('GET example.com')[0].parentSpanId).toBe(byName('inner')[0].spanId);
    expect(byName('explicit')[0].parentSpanId).toBe(root.spanId);
    expect(byName('DynamoDB.GetItem')[0].parentSpanId).toBe(root.spanId);
    expect(attrs(root).after).toBe(1);
  });

  it('does not write into a later invocation', async () => {
    const { invoke } = setupBridge();
    let first: Span | undefined;
    let ctx = ROOT_CONTEXT;
    const one = await invoke(() => {
      first = trace.getActiveSpan();
      ctx = context.active();
      first?.setAttribute('run', 1);
    });
    let second: Span | undefined;
    const two = await invoke(async () => {
      first?.setAttribute('leak', true);
      first?.setStatus({ code: SpanStatusCode.ERROR });
      context.with(ctx, () => trace.getActiveSpan()?.setAttribute('leak.ctx', true));
      second = trace.getActiveSpan();
      second?.setAttribute('run', 2);
    });
    expect(second).not.toBe(first);
    expect(attrs(one.root).run).toBe(1);
    expect(attrs(two.root).run).toBe(2);
    for (const root of [one.root, two.root]) {
      expect('leak' in attrs(root)).toBe(false);
      expect('leak.ctx' in attrs(root)).toBe(false);
    }
    expect(two.root.status).toEqual({ code: 0 });
  });
});
