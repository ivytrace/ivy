import { overQuota, type EffectiveLimits } from './limits.js';
import { monthBounds, monthOf, type Month } from './usage.js';

export interface QuotaSnapshot {
  limits: EffectiveLimits;
  /** Traces this month according to ClickHouse at refresh time (0 when the limits can't block). */
  used: number;
  /** Where this workspace upgrades (its usage page), for the 429 message. */
  upgradeUrl?: string;
}

export interface QuotaGateOptions {
  /** Limits and this month's usage of a tenant. */
  load: (tenantId: string, shardId: string, month: Month) => Promise<QuotaSnapshot>;
  /** How long a snapshot is used before it is refreshed in the background. */
  refreshMs?: number;
  /** Longest Retry-After sent while over quota, so an upgrade takes effect soon after. */
  recheckSeconds?: number;
  /** Where to upgrade, for the 429 message, when the snapshot has no workspace-specific link. */
  upgradeUrl?: string;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface QuotaBlock {
  retryAfter: number;
  message: string;
}

interface Entry {
  month: Month;
  snapshot: QuotaSnapshot;
  /** Traces this process accepted since the snapshot's query started. */
  local: number;
  refreshedAt: number;
}

const FAILURE_RETRY_MS = 10_000;

/**
 * Monthly trace quota check for the ingest router. Per tenant it keeps the limits and the month's
 * usage from ClickHouse, refreshed every `refreshMs` in the background, plus the traces this
 * process accepted since. See docs/implementation/limits.md for the tolerance.
 */
export class QuotaGate {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();
  private refreshMs: number;
  private recheckSeconds: number;
  private now: () => number;

  constructor(private opts: QuotaGateOptions) {
    this.refreshMs = opts.refreshMs ?? 60_000;
    this.recheckSeconds = opts.recheckSeconds ?? 300;
    this.now = opts.now ?? Date.now;
  }

  /** Null when the tenant may ingest; the 429 details otherwise. Fails open if the lookup fails. */
  async check(tenantId: string, shardId: string): Promise<QuotaBlock | null> {
    const now = this.now();
    const month = monthOf(now);
    let entry = this.entries.get(tenantId);
    if (!entry || entry.month !== month) {
      await this.refresh(tenantId, shardId, month);
      entry = this.entries.get(tenantId);
      if (!entry) return null;
    } else if (now - entry.refreshedAt >= this.refreshMs) {
      void this.refresh(tenantId, shardId, month);
    }
    const { limits, used, upgradeUrl } = entry.snapshot;
    if (!overQuota(limits, used + entry.local)) return null;
    const untilNextMonth = Math.ceil((monthBounds(month).end - now) / 1000);
    return {
      retryAfter: Math.max(1, Math.min(this.recheckSeconds, untilNextMonth)),
      message: quotaMessage(limits, upgradeUrl ?? this.opts.upgradeUrl),
    };
  }

  /** Counts traces the collector accepted for a tenant. */
  add(tenantId: string, traces: number): void {
    const entry = this.entries.get(tenantId);
    if (entry && traces > 0) entry.local += traces;
  }

  private refresh(tenantId: string, shardId: string, month: Month): Promise<void> {
    const key = `${tenantId}/${month}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const startedAt = this.now();
    const before = this.entries.get(tenantId);
    const localBefore = before?.month === month ? before.local : 0;
    const run = this.opts
      .load(tenantId, shardId, month)
      .then((snapshot) => {
        const current = this.entries.get(tenantId);
        // Traces accepted while the query ran may or may not be in its result; keep counting them.
        const local = current?.month === month ? Math.max(0, current.local - localBefore) : 0;
        this.entries.set(tenantId, { month, snapshot, local, refreshedAt: startedAt });
      })
      .catch((err) => {
        this.opts.log?.(`quota lookup for ${tenantId} failed (allowing ingest): ${(err as Error).message}`);
        const retryAt = startedAt - this.refreshMs + FAILURE_RETRY_MS;
        const current = this.entries.get(tenantId);
        if (current?.month === month) current.refreshedAt = retryAt;
        else this.entries.set(tenantId, { month, snapshot: FAIL_OPEN, local: 0, refreshedAt: retryAt });
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }
}

const FAIL_OPEN: QuotaSnapshot = { limits: { plan: '', monthly_trace_quota: null, over_quota: 'allow', source: 'unset' }, used: 0 };

export function quotaMessage(limits: EffectiveLimits, upgradeUrl?: string): string {
  const quota = limits.monthly_trace_quota!.toLocaleString('en-US');
  const plan = limits.plan ? ` on the ${limits.plan} plan` : '';
  const upgrade = upgradeUrl ? `Upgrade at ${upgradeUrl}` : "Upgrade the workspace's plan or ask the Ivy operator to raise the quota";
  return `Monthly trace quota reached (${quota} traces${plan}). Traces are rejected until the next month (UTC). ${upgrade}.`;
}
