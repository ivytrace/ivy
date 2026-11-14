import type { Usage } from "../api/types.ts";

/**
 * - `unlimited`: no quota.
 * - `ok` / `warning` (≥ 80%) / `blocked` (≥ 100%, ingest refused): a quota that blocks.
 * - `included` / `overage`: a quota that doesn't block (paid): under it, or billed beyond it.
 */
export type UsageLevel = "unlimited" | "ok" | "warning" | "blocked" | "included" | "overage";

export interface UsageState {
  level: UsageLevel;
  /** traces / quota, uncapped; null when unlimited. */
  ratio: number | null;
  /** Show the banner (dashboard-wide): close to or at a quota that blocks. */
  banner: "warning" | "blocked" | null;
}

export const WARNING_RATIO = 0.8;

export function usageState(usage: Usage): UsageState {
  const quota = usage.limits.monthly_trace_quota;
  if (quota === null) return { level: "unlimited", ratio: null, banner: null };
  const ratio = quota === 0 ? (usage.traces > 0 ? Infinity : 1) : usage.traces / quota;
  if (usage.limits.over_quota === "allow") return { level: ratio >= 1 ? "overage" : "included", ratio, banner: null };
  if (usage.blocked || ratio >= 1) return { level: "blocked", ratio, banner: "blocked" };
  if (ratio >= WARNING_RATIO) return { level: "warning", ratio, banner: "warning" };
  return { level: "ok", ratio, banner: null };
}

/** Width of the progress bar, 0–100. */
export const barPercent = (ratio: number | null) => (ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100)));
