import { describe, expect, it } from 'vitest';
import { effectiveLimits, InvalidLimitsError, overQuota, parseLimits } from './limits.js';
import { memoryLimitsStore } from './store.js';
import { monthBounds, monthOf, monthRange } from './usage.js';

describe('limits', () => {
  it('is unlimited without a row', () => {
    expect(effectiveLimits(null)).toEqual({ plan: '', monthly_trace_quota: null, over_quota: 'allow', source: 'unset' });
    const row = { plan: 'Free', monthly_trace_quota: 50_000, over_quota: 'block' as const };
    expect(effectiveLimits(row)).toEqual({ ...row, source: 'workspace' });
  });

  it('blocks only with a quota, block, and usage at or over it', () => {
    const free = { plan: 'Free', monthly_trace_quota: 100, over_quota: 'block' as const };
    expect(overQuota(free, 99)).toBe(false);
    expect(overQuota(free, 100)).toBe(true);
    expect(overQuota({ ...free, over_quota: 'allow' }, 1_000)).toBe(false);
    expect(overQuota({ ...free, monthly_trace_quota: null }, 1_000)).toBe(false);
    expect(overQuota({ ...free, monthly_trace_quota: 0 }, 0)).toBe(true);
  });

  it('validates limit bodies', () => {
    expect(parseLimits({ plan: 'Pro', monthly_trace_quota: 50_000, over_quota: 'allow' })).toEqual({
      plan: 'Pro',
      monthly_trace_quota: 50_000,
      over_quota: 'allow',
    });
    expect(parseLimits({})).toEqual({ plan: '', monthly_trace_quota: null, over_quota: 'allow' });
    for (const bad of [null, [], { monthly_trace_quota: -1 }, { monthly_trace_quota: 1.5 }, { monthly_trace_quota: '5' }, { over_quota: 'drop' }, { plan: 5 }]) {
      expect(() => parseLimits(bad), JSON.stringify(bad)).toThrow(InvalidLimitsError);
    }
  });
});

describe('memory limits store', () => {
  it('creates, reads, replaces, lists and removes', async () => {
    const store = memoryLimitsStore();
    expect(await store.get('ten_a')).toBeNull();
    await store.save('ten_a', { plan: 'Free', monthly_trace_quota: 10, over_quota: 'block' });
    await store.save('ten_b', { plan: 'Pro', monthly_trace_quota: 10, over_quota: 'allow' });
    await store.save('ten_a', { plan: 'Pro', monthly_trace_quota: 10, over_quota: 'allow' });
    expect((await store.get('ten_a'))?.plan).toBe('Pro');
    expect((await store.list()).map((r) => r.tenant_id)).toEqual(['ten_a', 'ten_b']);
    await store.remove('ten_a');
    expect(await store.get('ten_a')).toBeNull();
  });
});

describe('months', () => {
  it('uses calendar months in UTC', () => {
    expect(monthOf(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe('2026-11');
    expect(monthBounds('2026-12')).toEqual({ start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) });
    const now = Date.UTC(2026, 10, 14, 12, 30);
    expect(monthRange('2026-11', now)).toEqual({ from: Date.UTC(2026, 10, 1), to: now });
    expect(monthRange('2026-10', now)).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) });
    expect(() => monthBounds('2026-13')).toThrow();
  });
});
