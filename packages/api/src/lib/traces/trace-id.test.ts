import { describe, expect, it } from 'vitest';
import { isTraceId, traceIdTimestamp } from './trace-id.js';

const now = Date.parse('2026-11-14T12:00:00Z');

describe('traceIdTimestamp', () => {
  it('reads the timestamp prefix', () => {
    const seconds = Math.floor(now / 1000) - 60;
    const id = seconds.toString(16).padStart(8, '0') + 'a'.repeat(24);
    expect(traceIdTimestamp(id, now)).toBe(seconds);
  });

  it('ignores implausible prefixes', () => {
    expect(traceIdTimestamp('00000001' + 'a'.repeat(24), now)).toBeUndefined();
    expect(traceIdTimestamp('ffffffff' + 'a'.repeat(24), now)).toBeUndefined();
  });
});

describe('isTraceId', () => {
  it('accepts 32 lowercase hex chars only', () => {
    expect(isTraceId('a'.repeat(32))).toBe(true);
    expect(isTraceId('A'.repeat(32))).toBe(false);
    expect(isTraceId('a'.repeat(31))).toBe(false);
  });
});
