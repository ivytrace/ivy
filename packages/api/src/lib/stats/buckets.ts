import type { TimeRange } from '../utils/time-range.js';

export const BUCKET_SECONDS: Record<string, number> = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86400 };

export function pickBucket(range: TimeRange): string {
  const span = range.to - range.from;
  if (span <= 2 * 3_600_000) return '1m';
  if (span <= 26 * 3_600_000) return '5m';
  if (span <= 8 * 86_400_000) return '1h';
  return '1d';
}
