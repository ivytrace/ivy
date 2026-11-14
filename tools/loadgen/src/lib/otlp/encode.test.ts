import { describe, expect, it } from 'vitest';
import { FUNCTIONS } from '../functions/catalog.js';
import { generateInvocation } from '../trace/generate.js';
import { attributes, encodeTraces, unixNano } from './encode.js';

describe('unixNano', () => {
  it('keeps sub-millisecond precision without float overflow', () => {
    expect(unixNano(1731600000123.5)).toBe('1731600000123500000');
  });
});

describe('attributes', () => {
  it('maps value types', () => {
    expect(attributes({ s: 'x', b: true, i: 3, d: 1.5, a: ['t'] })).toEqual([
      { key: 's', value: { stringValue: 'x' } },
      { key: 'b', value: { boolValue: true } },
      { key: 'i', value: { intValue: '3' } },
      { key: 'd', value: { doubleValue: 1.5 } },
      { key: 'a', value: { arrayValue: { values: [{ stringValue: 't' }] } } },
    ]);
  });
});

describe('generated invocations', () => {
  const start = Date.parse('2026-11-14T12:00:00Z');

  it.each(FUNCTIONS.map((fn) => [fn.name, fn] as const))('%s follows the span conventions', (_name, fn) => {
    for (let i = 0; i < 30; i++) {
      const inv = generateInvocation(fn, start, { coldStart: i === 0, errorBoost: 0 });
      const [root, ...children] = inv.spans;
      expect(root.attributes['ivy.invocation']).toBe(true);
      expect(root.parentSpanId).toBe('');
      expect(root.attributes['faas.coldstart']).toBe(i === 0);
      expect(root.attributes['ivy.trigger.source']).toBe(fn.triggerSource);
      expect(typeof root.attributes['ivy.payload.request']).toBe('string');
      expect(Number.parseInt(root.traceId.slice(0, 8), 16)).toBe(start / 1000);
      if (inv.error) {
        expect(root.status?.code).toBe('ERROR');
        expect(root.attributes['error.type']).toBeTruthy();
        expect(root.events.some((e) => e.name === 'exception')).toBe(true);
      }
      for (const child of children) {
        expect(child.kind).toBe('CLIENT');
        expect(child.parentSpanId).toBe(root.spanId);
        expect(child.startMs).toBeGreaterThanOrEqual(root.startMs);
        expect(child.endMs).toBeLessThanOrEqual(root.endMs);
        if (child.attributes['rpc.system']) expect(child.name).toBe(`${child.attributes['rpc.service']}.${child.attributes['rpc.method']}`);
      }
    }
  });

  it('encodes one resource per function', () => {
    const invocations = FUNCTIONS.map((fn) => generateInvocation(fn, start, { coldStart: false, errorBoost: 0 }));
    const body = encodeTraces(invocations);
    expect(body.resourceSpans).toHaveLength(FUNCTIONS.length);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
