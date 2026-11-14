import type { Invocation } from "../api/types";

/** Live mode on the Invocations page: how often it polls and when it pauses (docs/implementation/ui.md). */
export const LIVE_INTERVAL_MS = 3000;
export const MIN_INTERVAL_MS = 2000;
export const MAX_BACKOFF_MS = 30_000;
export const IDLE_PAUSE_MS = 15 * 60_000;
export const MAX_LIVE_ROWS = 200;
export const MAX_REFRESH_IDS = 100;
/** Polls ask for rows from a second before the newest one, so a row stored a little late isn't skipped; duplicates are merged. */
export const OVERLAP_MS = 1000;
export const HIGHLIGHT_MS = 2500;

export const rowKey = (row: Pick<Invocation, "trace_id" | "span_id">) => `${row.trace_id}:${row.span_id}`;

/** Lower bound of the next poll: the newest row's start minus `OVERLAP_MS`; null without rows. */
export function sinceCursor(rows: Pick<Invocation, "ts">[]): string | null {
  let newest = -Infinity;
  for (const r of rows) newest = Math.max(newest, Date.parse(r.ts));
  return Number.isFinite(newest) ? new Date(newest - OVERLAP_MS).toISOString() : null;
}

/**
 * Merges polled rows into the list: a row already shown is replaced in place (an in-progress row that
 * finished), new rows are prepended newest first. Returns the keys of the new rows.
 */
export function mergeRows(rows: Invocation[], incoming: Invocation[], max = MAX_LIVE_ROWS): { rows: Invocation[]; added: string[] } {
  if (!incoming.length) return { rows, added: [] };
  const byKey = new Map(incoming.map((r) => [rowKey(r), r]));
  const replaced = rows.map((r) => {
    const next = byKey.get(rowKey(r));
    if (next) byKey.delete(rowKey(r));
    return next ?? r;
  });
  const fresh = [...byKey.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  return { rows: [...fresh, ...replaced].slice(0, max), added: fresh.map(rowKey) };
}

/** Span IDs of the in-progress rows to refresh in place. */
export function refreshIds(rows: Invocation[]): string[] {
  return rows.filter((r) => r.status === "in_progress").slice(0, MAX_REFRESH_IDS).map((r) => r.span_id);
}

/** Delay before the next poll: the normal interval, doubling after each failed poll up to `MAX_BACKOFF_MS`. */
export function nextDelay(failures: number, interval = LIVE_INTERVAL_MS): number {
  const base = Math.max(interval, MIN_INTERVAL_MS);
  return Math.min(base * 2 ** Math.max(0, failures), Math.max(MAX_BACKOFF_MS, base));
}

export type PauseReason = "hidden" | "idle" | "paginated" | "scrolled";

/** Why live updates are paused, if they are. Hidden and idle stop polling; paginated and scrolled only hold new rows back. */
export function pauseReason(s: { hidden: boolean; idleMs: number; paginated: boolean; scrolled: boolean }): PauseReason | null {
  if (s.hidden) return "hidden";
  if (s.idleMs >= IDLE_PAUSE_MS) return "idle";
  if (s.paginated) return "paginated";
  if (s.scrolled) return "scrolled";
  return null;
}

export const stopsPolling = (reason: PauseReason | null) => reason === "hidden" || reason === "idle";
