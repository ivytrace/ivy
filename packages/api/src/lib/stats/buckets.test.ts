import { describe, expect, it } from 'vitest';
import { pickBucket } from './buckets.js';

const to = Date.parse('2026-11-14T12:00:00Z');
const H = 3_600_000;

describe('pickBucket', () => {
  it('scales the bucket with the range', () => {
    expect(pickBucket({ from: to - 0.25 * H, to })).toBe('1m');
    expect(pickBucket({ from: to - 6 * H, to })).toBe('5m');
    expect(pickBucket({ from: to - 24 * H, to })).toBe('15m');
    expect(pickBucket({ from: to - 7 * 24 * H, to })).toBe('1h');
    expect(pickBucket({ from: to - 30 * 24 * H, to })).toBe('1d');
  });

  it('keeps charts at roughly 100 points or fewer for the presets', () => {
    for (const hours of [0.25, 1, 24]) {
      const bucketMs = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': H, '1d': 24 * H }[pickBucket({ from: to - hours * H, to })]!;
      expect((hours * H) / bucketMs).toBeLessThanOrEqual(105);
    }
  });
});
