import type { TimeRange } from '../utils/time-range.js';

export const BUCKET_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

const H = 3_600_000;

export function pickBucket(range: TimeRange): string {
  const span = range.to - range.from;
  if (span <= 1.5 * H) return '1m';
  if (span <= 8 * H) return '5m';
  if (span <= 26 * H) return '15m';
  if (span <= 8 * 24 * H) return '1h';
  return '1d';
}
