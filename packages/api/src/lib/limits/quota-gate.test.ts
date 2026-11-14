import { describe, expect, it } from 'vitest';
import type { EffectiveLimits } from './limits.js';
import { QuotaGate, type QuotaSnapshot } from './quota-gate.js';

const FREE: EffectiveLimits = { plan: 'Free', monthly_trace_quota: 100, over_quota: 'block', source: 'workspace' };

function setup(snapshot: () => QuotaSnapshot | Promise<QuotaSnapshot>, start = Date.UTC(2026, 10, 14, 12)) {
  let now = start;
  let loads = 0;
  const gate = new QuotaGate({
    load: async () => {
      loads++;
      return snapshot();
    },
    refreshMs: 60_000,
    recheckSeconds: 300,
    upgradeUrl: 'https://ivy.example/settings/usage',
    now: () => now,
  });
  return {
    gate,
    loads: () => loads,
    advance: (ms: number) => (now += ms),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('QuotaGate', () => {
  it('never blocks a workspace without limits', async () => {
    const { gate } = setup(() => ({ limits: { plan: '', monthly_trace_quota: null, over_quota: 'allow', source: 'unset' }, used: 0 }));
    gate.add('ten_a', 10_000_000);
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
  });

  it('never blocks with over_quota allow', async () => {
    const { gate } = setup(() => ({ limits: { ...FREE, over_quota: 'allow' }, used: 5_000 }));
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
  });

  it('blocks at the quota with block, with a message and a Retry-After', async () => {
    const { gate } = setup(() => ({ limits: FREE, used: 100 }));
    const blocked = await gate.check('ten_a', 'shard-1');
    expect(blocked?.retryAfter).toBe(300);
    expect(blocked?.message).toContain('Monthly trace quota reached (100 traces on the Free plan)');
    expect(blocked?.message).toContain('Upgrade at https://ivy.example/settings/usage');
  });

  it('adds the traces accepted since the refresh', async () => {
    const { gate } = setup(() => ({ limits: FREE, used: 90 }));
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
    gate.add('ten_a', 9);
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
    gate.add('ten_a', 1);
    expect(await gate.check('ten_a', 'shard-1')).not.toBeNull();
    gate.add('ten_b', 1_000);
    expect(await gate.check('ten_b', 'shard-1')).toBeNull();
  });

  it('refreshes in the background after refreshMs, and the new count replaces the local one', async () => {
    let used = 90;
    const { gate, loads, advance } = setup(() => ({ limits: FREE, used }));
    await gate.check('ten_a', 'shard-1');
    gate.add('ten_a', 5);
    advance(30_000);
    await gate.check('ten_a', 'shard-1');
    expect(loads()).toBe(1);
    used = 95;
    advance(31_000);
    await gate.check('ten_a', 'shard-1');
    await flush();
    expect(loads()).toBe(2);
    gate.add('ten_a', 4);
    expect(await gate.check('ten_a', 'shard-1')).toBeNull(); // 95 + 4
    gate.add('ten_a', 1);
    expect(await gate.check('ten_a', 'shard-1')).not.toBeNull();
  });

  it('picks up an upgrade on the next refresh', async () => {
    let limits = FREE;
    const { gate, advance } = setup(() => ({ limits, used: 500 }));
    expect(await gate.check('ten_a', 'shard-1')).not.toBeNull();
    limits = { ...FREE, plan: 'Pro', over_quota: 'allow' };
    advance(61_000);
    await gate.check('ten_a', 'shard-1');
    await flush();
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
  });

  it('starts over in a new month and caps Retry-After at the month end', async () => {
    let used = 100;
    const { gate, advance } = setup(() => ({ limits: FREE, used }), Date.UTC(2026, 10, 30, 23, 59, 0));
    expect((await gate.check('ten_a', 'shard-1'))?.retryAfter).toBe(60);
    used = 0;
    advance(61_000);
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
  });

  it('shares the first load between concurrent requests', async () => {
    const { gate, loads } = setup(() => ({ limits: FREE, used: 0 }));
    await Promise.all([gate.check('ten_a', 'shard-1'), gate.check('ten_a', 'shard-1'), gate.check('ten_a', 'shard-1')]);
    expect(loads()).toBe(1);
  });

  it('fails open when the lookup fails, and retries after 10 s', async () => {
    let fail = true;
    const { gate, loads, advance } = setup(() => {
      if (fail) throw new Error('down');
      return { limits: FREE, used: 100 };
    });
    expect(await gate.check('ten_a', 'shard-1')).toBeNull();
    advance(5_000);
    await gate.check('ten_a', 'shard-1');
    expect(loads()).toBe(1);
    fail = false;
    advance(6_000);
    await gate.check('ten_a', 'shard-1');
    await flush();
    expect(loads()).toBe(2);
    expect(await gate.check('ten_a', 'shard-1')).not.toBeNull();
  });
});
