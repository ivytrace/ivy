import { describe, expect, it } from 'vitest';
import { backfillTimestamps, incidentFor, InvocationSource } from './schedule.js';

const now = Date.parse('2026-11-14T12:00:00Z');

describe('backfillTimestamps', () => {
  it('returns sorted timestamps inside the window', () => {
    const ts = backfillTimestamps(500, 24, now);
    expect(ts).toHaveLength(500);
    expect(ts[0]).toBeGreaterThanOrEqual(now - 24 * 3_600_000);
    expect(ts.at(-1)).toBeLessThanOrEqual(now);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
});

describe('InvocationSource', () => {
  it('produces roughly 5% errors outside incidents', () => {
    const source = new InvocationSource();
    let errors = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (source.next(now + i * 1000).error) errors++;
    expect(errors / n).toBeGreaterThan(0.02);
    expect(errors / n).toBeLessThan(0.09);
  });

  it('places incidents inside the backfill window', () => {
    const incident = incidentFor(24, now)!;
    expect(incident.from).toBeGreaterThan(now - 24 * 3_600_000);
    expect(incident.to).toBeLessThan(now);
    expect(incidentFor(1, now)).toBeUndefined();
  });
});
