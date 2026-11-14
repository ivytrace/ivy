import { describe, expect, it } from 'vitest';
import { newSpanId, newTraceId } from './ids.js';

describe('ids', () => {
  it('trace IDs start with the big-endian unix timestamp in seconds', () => {
    const ms = Date.UTC(2024, 10, 21, 10, 0, 0);
    const id = newTraceId(ms);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(parseInt(id.slice(0, 8), 16)).toBe(ms / 1000);
    expect(id.slice(0, 8)).toBe('673f04a0');
  });

  it('are random after the prefix', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newTraceId(0).slice(8)));
    expect(ids.size).toBe(2000);
  });

  it('span IDs are 16 hex chars and unique', () => {
    const ids = new Set(Array.from({ length: 5000 }, newSpanId));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
