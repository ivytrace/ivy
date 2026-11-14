import { badRequest } from './http-error.js';

export interface TimeRange {
  from: number;
  to: number;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[match[2]];
}

function parseIso(value: string, name: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw badRequest(`Invalid ${name}: ${value}`);
  return ms;
}

export function parseTimeRange(
  params: { since?: string; from?: string; to?: string },
  now = Date.now(),
): TimeRange {
  const to = params.to ? parseIso(params.to, 'to') : now;
  let from: number;
  if (params.from) {
    from = parseIso(params.from, 'from');
  } else {
    const since = params.since ?? '24h';
    const duration = parseDuration(since);
    if (!duration) throw badRequest(`Invalid since: ${since}`);
    from = to - duration;
  }
  if (from >= to) throw badRequest('from must be before to');
  return { from, to };
}

const HOUR = 3_600_000;

/** Splits a range into whole hours (served from the hourly rollup) and the raw edges around them. */
export function splitOnHours(range: TimeRange): { h1: number; h2: number } {
  const h1 = Math.ceil(range.from / HOUR) * HOUR;
  const h2 = Math.floor(range.to / HOUR) * HOUR;
  if (h1 >= h2) return { h1: range.to, h2: range.to };
  return { h1, h2 };
}
