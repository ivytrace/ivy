export type OverQuota = 'block' | 'allow';

/** What a workspace may ingest per calendar month (UTC). A null quota is unlimited. */
export interface Limits {
  plan: string;
  monthly_trace_quota: number | null;
  over_quota: OverQuota;
}

/** A workspace's limits; `source: 'unset'` means it has no row and is unlimited. */
export interface EffectiveLimits extends Limits {
  source: 'workspace' | 'unset';
}

export const UNLIMITED: Limits = { plan: '', monthly_trace_quota: null, over_quota: 'allow' };

/** The workspace's row, or unlimited without one. */
export function effectiveLimits(row: Limits | null): EffectiveLimits {
  if (!row) return { ...UNLIMITED, source: 'unset' };
  return { plan: row.plan, monthly_trace_quota: row.monthly_trace_quota, over_quota: row.over_quota, source: 'workspace' };
}

/** True when ingest has to be refused: a quota, `block`, and usage at or over it. */
export function overQuota(limits: Limits, used: number): boolean {
  return limits.over_quota === 'block' && limits.monthly_trace_quota !== null && used >= limits.monthly_trace_quota;
}

export class InvalidLimitsError extends Error {}

/** Validates a body like `{ plan, monthly_trace_quota, over_quota }`. */
export function parseLimits(body: unknown): Limits {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidLimitsError('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const plan = b.plan ?? '';
  if (typeof plan !== 'string' || plan.length > 64) throw new InvalidLimitsError('plan must be a string of at most 64 characters');
  const quota = b.monthly_trace_quota ?? null;
  if (quota !== null && (typeof quota !== 'number' || !Number.isSafeInteger(quota) || quota < 0)) {
    throw new InvalidLimitsError('monthly_trace_quota must be a whole number ≥ 0, or null for unlimited');
  }
  const over = b.over_quota ?? 'allow';
  if (over !== 'block' && over !== 'allow') throw new InvalidLimitsError('over_quota must be "block" or "allow"');
  return { plan, monthly_trace_quota: quota, over_quota: over };
}
