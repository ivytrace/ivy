/**
 * Counts invalid-key attempts per client IP in fixed windows. Once an IP passes `maxFailures` in a
 * window, it is blocked until the window ends (except for keys already known to be valid, so one
 * bad client behind a shared NAT doesn't lock out the others).
 */
export class FailureLimiter {
  private windows = new Map<string, { start: number; failures: number }>();

  constructor(
    private maxFailures = 20,
    private windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Seconds until the IP may try again, or 0 when it isn't blocked. */
  blockedFor(ip: string): number {
    const w = this.windows.get(ip);
    if (!w || w.failures < this.maxFailures) return 0;
    const left = w.start + this.windowMs - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  fail(ip: string): void {
    const now = this.now();
    let w = this.windows.get(ip);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, failures: 0 };
      this.windows.set(ip, w);
    }
    w.failures++;
    if (this.windows.size > 100_000) this.prune();
  }

  prune(): void {
    const now = this.now();
    for (const [ip, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(ip);
  }
}
