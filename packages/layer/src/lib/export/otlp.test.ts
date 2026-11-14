import { describe, expect, it } from 'vitest';
import { createSpan, recordError, SpanKind } from '../tracer/span.js';
import { buildExportRequest, encodeSpan, msToNanos, toAnyValue, toKeyValues } from './otlp.js';

describe('otlp encoding', () => {
  it('converts epoch ms to nanosecond strings without precision loss', () => {
    expect(msToNanos(1732183200000)).toBe('1732183200000000000');
    expect(msToNanos(1732183200000.123)).toBe('1732183200000123000');
  });

  it('encodes attribute values per OTLP JSON', () => {
    expect(toAnyValue('a')).toEqual({ stringValue: 'a' });
    expect(toAnyValue(true)).toEqual({ boolValue: true });
    expect(toAnyValue(42)).toEqual({ intValue: '42' });
    expect(toAnyValue(1.5)).toEqual({ doubleValue: 1.5 });
    expect(toAnyValue(['x', 'y'])).toEqual({ arrayValue: { values: [{ stringValue: 'x' }, { stringValue: 'y' }] } });
    expect(toKeyValues({ a: 1, b: NaN, c: undefined as any })).toEqual([{ key: 'a', value: { intValue: '1' } }]);
  });

  it('encodes a span with hex ids, kind, events and status', () => {
    const span = createSpan('673f04a0aaaaaaaaaaaaaaaaaaaaaaaa', 'fn', SpanKind.SERVER, 1000, 'bbbbbbbbbbbbbbbb');
    span.endMs = 1010.5;
    span.attributes['ivy.invocation'] = true;
    recordError(span, new TypeError('bad'), 1010);
    const out = encodeSpan(span);
    expect(out).toMatchObject({
      traceId: '673f04a0aaaaaaaaaaaaaaaaaaaaaaaa',
      parentSpanId: 'bbbbbbbbbbbbbbbb',
      name: 'fn',
      kind: 2,
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1010500000',
      status: { code: 2, message: 'bad' },
    });
    expect(out.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(out.attributes).toContainEqual({ key: 'error.type', value: { stringValue: 'TypeError' } });
    expect(out.events[0].name).toBe('exception');
    expect(out.events[0].attributes.map((a) => a.key)).toEqual(['exception.type', 'exception.message', 'exception.stacktrace']);
  });

  it('omits parentSpanId for root spans and never ends before start', () => {
    const span = createSpan('t'.repeat(32), 'fn', SpanKind.INTERNAL, 2000);
    span.endMs = 1000;
    const out = encodeSpan(span);
    expect(out.parentSpanId).toBeUndefined();
    expect(out.endTimeUnixNano).toBe(out.startTimeUnixNano);
  });

  it('groups batches by resource', () => {
    const r1 = [{ key: 'service.name', value: { stringValue: 'a' } }];
    const r2 = [{ key: 'service.name', value: { stringValue: 'b' } }];
    const s = encodeSpan(createSpan('t'.repeat(32), 'x', 1, 0));
    const req = buildExportRequest([
      { resource: r1, spans: [s] },
      { resource: r2, spans: [s] },
      { resource: r1, spans: [s] },
    ]);
    expect(req.resourceSpans).toHaveLength(2);
    expect(req.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(req.resourceSpans[0].scopeSpans[0].scope.name).toBe('ivy-layer');
  });
});
