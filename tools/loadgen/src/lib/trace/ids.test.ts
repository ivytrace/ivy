import { describe, expect, it } from 'vitest';
import { spanId, traceId } from './ids.js';

describe('ids', () => {
  it('prefixes trace IDs with the unix timestamp', () => {
    const ms = Date.parse('2026-11-14T12:00:00Z');
    const id = traceId(ms);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.parseInt(id.slice(0, 8), 16)).toBe(ms / 1000);
  });

  it('creates 64-bit span IDs', () => {
    expect(spanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
