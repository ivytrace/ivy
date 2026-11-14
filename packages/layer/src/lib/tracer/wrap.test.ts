import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/config.js';
import { Tracer, type SpanBatch } from './tracer.js';
import { wrapHandler } from './wrap.js';

function setup() {
  const batches: SpanBatch[] = [];
  const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://x' }), (b) => batches.push(b));
  const ctx = { awsRequestId: 'req-1', functionName: 'fn', invokedFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:fn', getRemainingTimeInMillis: () => 10_000 };
  const flushed = () => new Promise((r) => setImmediate(r)).then(() => batches);
  return { tracer, ctx, flushed };
}

describe('wrapHandler', () => {
  it('passes async results through and records the invocation', async () => {
    const { tracer, ctx, flushed } = setup();
    const result = { statusCode: 201 };
    const h = wrapHandler(tracer, async () => result);
    expect(h.constructor.name).toBe('AsyncFunction');
    await expect(h({ httpMethod: 'GET', path: '/', requestContext: {} }, ctx)).resolves.toBe(result);
    const [batch] = await flushed();
    expect(batch).toMatchObject({ requestId: 'req-1', final: true });
    const root = batch.spans[0];
    expect(root.attributes).toContainEqual({ key: 'ivy.invocation', value: { boolValue: true } });
    expect(root.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: '201' } });
    expect(root.attributes).toContainEqual({ key: 'faas.coldstart', value: { boolValue: true } });
    expect(batch.resource).toContainEqual({ key: 'cloud.account.id', value: { stringValue: '123456789012' } });
  });

  it('rethrows the same error object', async () => {
    const { tracer, ctx, flushed } = setup();
    const err = new Error('nope');
    const h = wrapHandler(tracer, async () => {
      throw err;
    });
    await expect(h({}, ctx)).rejects.toBe(err);
    const [batch] = await flushed();
    expect(batch.spans[0].status).toEqual({ code: 2, message: 'nope' });
  });

  it('supports callback handlers and keeps arity', async () => {
    const { tracer, ctx, flushed } = setup();
    const user = (_e: unknown, _c: unknown, cb: (err: unknown, res: unknown) => void) => {
      setTimeout(() => cb(null, "ok"), 1);
    };
    const h = wrapHandler(tracer, user as any);
    expect(h.length).toBe(3);
    const cb = vi.fn();
    expect(h({}, ctx, cb)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledWith(null, 'ok');
    const [batch] = await flushed();
    expect(batch.spans[0].attributes).toContainEqual({ key: 'ivy.payload.response', value: { stringValue: '"ok"' } });
  });

  it('propagates synchronous throws', () => {
    const { tracer, ctx } = setup();
    const err = new Error('sync');
    const h = wrapHandler(tracer, () => {
      throw err;
    });
    expect(() => h({}, ctx)).toThrow(err);
  });

  it('still runs the handler if tracing breaks', async () => {
    const { tracer, ctx } = setup();
    tracer.startInvocation = () => {
      throw new Error('tracer bug');
    };
    const h = wrapHandler(tracer, async () => 'fine');
    await expect(h({}, ctx)).resolves.toBe('fine');
  });

  it('captures console logs as span events', async () => {
    const { tracer, ctx, flushed } = setup();
    const h = wrapHandler(tracer, async () => {
      tracer.addLog('info', 'hello');
    });
    await h({}, ctx);
    const [batch] = await flushed();
    expect(batch.spans[0].events[0]).toMatchObject({ name: 'log', attributes: [{ key: 'log.severity' }, { key: 'log.message', value: { stringValue: 'hello' } }] });
  });
});
