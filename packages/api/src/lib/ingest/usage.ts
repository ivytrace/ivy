export interface TenantUsage {
  requests: number;
  spans: number;
  bytes: number;
}

/**
 * Accepted traffic per tenant since the process started, in memory. A hook for M6 quotas:
 * nothing is enforced yet, and counts are per router process.
 */
export class UsageCounters {
  private totals = new Map<string, TenantUsage>();
  private lastLogged = new Map<string, TenantUsage>();

  add(tenant: string, spans: number, bytes: number): void {
    const u = this.totals.get(tenant) ?? { requests: 0, spans: 0, bytes: 0 };
    u.requests++;
    u.spans += spans;
    u.bytes += bytes;
    this.totals.set(tenant, u);
  }

  snapshot(): Record<string, TenantUsage> {
    return Object.fromEntries([...this.totals].map(([t, u]) => [t, { ...u }]));
  }

  /** Per-tenant increments since the previous call (for periodic log lines). */
  deltas(): Record<string, TenantUsage> {
    const out: Record<string, TenantUsage> = {};
    for (const [tenant, u] of this.totals) {
      const prev = this.lastLogged.get(tenant) ?? { requests: 0, spans: 0, bytes: 0 };
      if (u.requests === prev.requests) continue;
      out[tenant] = { requests: u.requests - prev.requests, spans: u.spans - prev.spans, bytes: u.bytes - prev.bytes };
      this.lastLogged.set(tenant, { ...u });
    }
    return out;
  }
}
