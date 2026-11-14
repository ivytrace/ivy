import { describe, expect, it } from 'vitest';
import { SpanStore } from './store.js';

const span = (spanId: string, name = 'x') => ({ spanId, name }) as any;

describe('SpanStore', () => {
  it('resolves when the final batch arrives (before or after waiting)', async () => {
    const s = new SpanStore();
    s.add('r1', true, [], [span('a')]);
    expect(await s.waitFor('r1', 1000)).toBe(true);
    const p = s.waitFor('r2', 1000);
    s.add('r2', true, [], [span('b')]);
    expect(await p).toBe(true);
  });

  it('times out without a final batch', async () => {
    const s = new SpanStore();
    s.add('r1', false, [], [span('a')]);
    expect(await s.waitFor('r1', 10)).toBe(false);
  });

  it('final batch supersedes provisional spans with the same id', () => {
    const s = new SpanStore();
    s.add('r1', false, [], [span('root', 'timeout')]);
    s.add('r1', true, [], [span('root', 'final'), span('child')]);
    const batches = s.drain();
    expect(batches).toHaveLength(1);
    expect(batches[0].spans.map((x) => x.name)).toEqual(['final', 'x']);
    expect(s.drain()).toEqual([]);
  });
});
