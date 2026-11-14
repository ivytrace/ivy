import { describe, expect, it } from 'vitest';
import { ExportQueue } from './queue.js';
import type { OtlpSpan } from './otlp.js';

const span = (id: string): OtlpSpan => ({
  traceId: 't'.repeat(32),
  spanId: id,
  name: 'x',
  kind: 1,
  startTimeUnixNano: '0',
  endTimeUnixNano: '0',
  attributes: [],
  events: [],
  status: { code: 0 },
});

function setup(results: (boolean | { ok: boolean; retryAfterMs?: number })[], maxQueueSpans = 10) {
  const sent: any[] = [];
  let t = 0;
  const q = new ExportQueue({
    url: 'http://x',
    maxQueueSpans,
    exportTimeoutMs: 100,
    now: () => t,
    send: async (body) => {
      sent.push(JSON.parse(body));
      return results.shift() ?? true;
    },
  });
  return { q, sent, advance: (ms: number) => (t += ms) };
}

const dropped = (req: any) =>
  req.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((a: any) => a.key === 'ivy.dropped_spans')?.value.intValue;

describe('ExportQueue', () => {
  it('exports queued batches', async () => {
    const { q, sent } = setup([true]);
    q.add({ resource: [], spans: [span('a'), span('b')] });
    await q.flush(1000);
    expect(sent).toHaveLength(1);
    expect(q.size).toBe(0);
  });

  it('drops a failed batch, backs off, and reports the dropped count on the next batch', async () => {
    const { q, sent, advance } = setup([false, true]);
    q.add({ resource: [], spans: [span('a'), span('b')] });
    await q.flush(1000);
    expect(q.dropped).toBe(2);

    q.add({ resource: [], spans: [span('c')] });
    await q.flush(1000);
    expect(sent).toHaveLength(1); // still backing off

    advance(10_000);
    await q.flush(1000);
    expect(sent).toHaveLength(2);
    expect(dropped(sent[1])).toBe('2');
    expect(q.dropped).toBe(0);
  });

  it('bounds the queue, dropping oldest spans', () => {
    const { q } = setup([], 3);
    q.add({ resource: [], spans: [span('a'), span('b')] });
    q.add({ resource: [], spans: [span('c'), span('d')] });
    expect(q.size).toBe(2);
    expect(q.dropped).toBe(2);
  });

  it('force flush ignores the backoff', async () => {
    const { q, sent } = setup([false, true]);
    q.add({ resource: [], spans: [span('a')] });
    await q.flush(1000);
    q.add({ resource: [], spans: [span('b')] });
    await q.flush(1000, true);
    expect(sent).toHaveLength(2);
  });

  it('honours Retry-After: no sends (not even forced) until it passes, spans dropped and counted', async () => {
    const { q, sent, advance } = setup([{ ok: false, retryAfterMs: 300_000 }, true]);
    q.add({ resource: [], spans: [span('a')] });
    await q.flush(1000);
    expect(q.dropped).toBe(1);

    advance(200_000);
    q.add({ resource: [], spans: [span('b')] });
    await q.flush(1000);
    await q.flush(1000, true);
    expect(sent).toHaveLength(1);

    advance(100_001);
    await q.flush(1000);
    expect(sent).toHaveLength(2);
    expect(dropped(sent[1])).toBe('1');
  });

  it('caps a very long Retry-After at an hour', async () => {
    const { q, sent, advance } = setup([{ ok: false, retryAfterMs: 30 * 86_400_000 }, true]);
    q.add({ resource: [], spans: [span('a')] });
    await q.flush(1000);
    advance(3_600_001);
    q.add({ resource: [], spans: [span('b')] });
    await q.flush(1000);
    expect(sent).toHaveLength(2);
  });
});
