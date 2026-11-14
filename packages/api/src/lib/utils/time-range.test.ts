import { describe, expect, it } from 'vitest';
import { parseDuration, parseTimeRange, splitOnHours } from './time-range.js';

const now = Date.parse('2026-11-14T12:30:00.000Z');

describe('parseTimeRange', () => {
  it('defaults to the last 24h', () => {
    expect(parseTimeRange({}, now)).toEqual({ from: now - 86_400_000, to: now });
  });

  it('accepts since values', () => {
    expect(parseTimeRange({ since: '15m' }, now).from).toBe(now - 900_000);
    expect(parseTimeRange({ since: '7d' }, now).from).toBe(now - 7 * 86_400_000);
  });

  it('lets from/to override since', () => {
    const range = parseTimeRange({ since: '1h', from: '2026-11-14T10:00:00Z', to: '2026-11-14T11:00:00Z' }, now);
    expect(range).toEqual({ from: Date.parse('2026-11-14T10:00:00Z'), to: Date.parse('2026-11-14T11:00:00Z') });
  });

  it('rejects invalid input', () => {
    expect(() => parseTimeRange({ since: 'yesterday' }, now)).toThrow();
    expect(() => parseTimeRange({ from: 'nope' }, now)).toThrow();
    expect(() => parseTimeRange({ from: '2026-11-15T00:00:00Z' }, now)).toThrow();
  });
});

describe('parseDuration', () => {
  it('parses minutes, hours and days', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1w')).toBeUndefined();
  });
});

describe('splitOnHours', () => {
  it('returns the whole hours inside the range', () => {
    const { h1, h2 } = splitOnHours({ from: Date.parse('2026-11-14T09:10:00Z'), to: now });
    expect(new Date(h1).toISOString()).toBe('2026-11-14T10:00:00.000Z');
    expect(new Date(h2).toISOString()).toBe('2026-11-14T12:00:00.000Z');
  });

  it('collapses to an empty rollup range when no whole hour fits', () => {
    const range = { from: now - 900_000, to: now };
    expect(splitOnHours(range)).toEqual({ h1: now, h2: now });
  });
});
