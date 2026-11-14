import { useCallback, useEffect, useRef, useState } from "react";
import { buildUrl, fetchJson, rangeParams, type QueryParams } from "../api/client";
import { scopePath, type InvocationFilters } from "../api/hooks";
import type { Invocation, InvocationsResponse, TimeRange } from "../api/types";
import { useScope } from "../links/use-scope";
import { HIGHLIGHT_MS, IDLE_PAUSE_MS, mergeRows, nextDelay, pauseReason, refreshIds, rowKey, sinceCursor, stopsPolling, type PauseReason } from "./live";

const SCROLL_PAUSE_PX = 240;
const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

function useHidden() {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

function useScrolled(enabled: boolean) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setScrolled(window.scrollY > SCROLL_PAUSE_PX);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [enabled]);
  return enabled && scrolled;
}

/** Time of the user's last interaction, sampled at most every few seconds. */
function useLastActive(enabled: boolean) {
  const [lastActive, setLastActive] = useState(() => Date.now());
  const latest = useRef(lastActive);
  useEffect(() => {
    if (!enabled) return;
    const touch = () => {
      const now = Date.now();
      if (now - latest.current > 5000) {
        latest.current = now;
        setLastActive(now);
      }
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, touch, { passive: true });
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, touch);
    };
  }, [enabled]);
  const reset = useCallback(() => {
    latest.current = Date.now();
    setLastActive(latest.current);
  }, []);
  return { lastActive, reset };
}

export interface LiveState {
  /** Rows to show on the first page while live (null when live is off). */
  rows: Invocation[] | null;
  paused: PauseReason | null;
  /** New rows held back while paused by scrolling or pagination; `more` when there were more than one poll returns. */
  pending: number;
  more: boolean;
  /** Keys (`rowKey`) of rows that just arrived, for a brief highlight. */
  fresh: Set<string>;
  failing: boolean;
  resume: () => void;
}

/**
 * Live updates of the invocation list: polls for rows newer than the newest one shown and refreshes
 * in-progress rows in place. `base` is the first page as loaded normally; `reload` refetches it.
 */
export function useLiveInvocations({
  enabled,
  range,
  filters,
  base,
  paginated,
  reload,
  fetcher = fetchJson,
}: {
  enabled: boolean;
  range: TimeRange;
  filters: InvocationFilters;
  base: Invocation[] | undefined;
  paginated: boolean;
  reload: () => void;
  fetcher?: <T>(url: string) => Promise<T>;
}): LiveState {
  const scope = useScope();
  const hidden = useHidden();
  const scrolled = useScrolled(enabled);
  const { lastActive, reset: resetIdle } = useLastActive(enabled);
  const [now, setNow] = useState(() => Date.now());
  const [rows, setRows] = useState<Invocation[] | null>(null);
  const [pending, setPending] = useState<Invocation[]>([]);
  const [more, setMore] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState(0);

  const paused = enabled ? pauseReason({ hidden, idleMs: now - lastActive, paginated, scrolled }) : null;
  const polling = enabled && !stopsPolling(paused);

  const state = useRef({ rows, pending, paused });
  state.current = { rows, pending, paused };

  useEffect(() => {
    if (!enabled) {
      setRows(null);
      setPending([]);
      setMore(false);
      return;
    }
    if (base) setRows(base);
  }, [enabled, base]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), Math.min(60_000, IDLE_PAUSE_MS / 4));
    return () => clearInterval(id);
  }, [enabled]);

  const highlight = useCallback((keys: string[]) => {
    if (!keys.length) return;
    setFresh((prev) => new Set([...prev, ...keys]));
    setTimeout(() => setFresh((prev) => new Set([...prev].filter((k) => !keys.includes(k)))), HIGHLIGHT_MS);
  }, []);

  const filterKey = JSON.stringify([scope.workspace, scope.project, range, filters]);
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let fails = 0;
    const listUrl = (params: QueryParams) => buildUrl(`${scopePath(scope)}/invocations`, { ...(filters as QueryParams), ...params });

    const poll = async () => {
      const { rows: shown, pending: held, paused: reason } = state.current;
      if (!shown) return;
      const from = sinceCursor([...shown, ...held]);
      const newer = await fetcher<InvocationsResponse>(listUrl(from ? { from, limit: 100 } : { ...rangeParams(range), limit: 100 }));
      if (cancelled) return;
      const holding = reason === "scrolled" || reason === "paginated";
      if (newer.next_cursor) {
        if (holding) setMore(true);
        else reload();
      } else if (holding) {
        const known = new Set(shown.map(rowKey));
        setPending((prev) => mergeRows(prev, newer.items.filter((r) => !known.has(rowKey(r)))).rows);
      } else {
        const merged = mergeRows(shown, newer.items);
        state.current.rows = merged.rows;
        setRows(merged.rows);
        highlight(merged.added);
      }
      const ids = refreshIds(state.current.rows ?? []);
      if (ids.length) {
        const current = await fetcher<InvocationsResponse>(listUrl({ ...rangeParams(range), ids: ids.join(","), limit: ids.length }));
        if (cancelled) return;
        const known = new Set((state.current.rows ?? []).map(rowKey));
        setRows((prev) => (prev ? mergeRows(prev, current.items.filter((r) => known.has(rowKey(r)))).rows : prev));
      }
    };

    const loop = async () => {
      try {
        await poll();
        fails = 0;
      } catch {
        fails++;
      }
      if (cancelled) return;
      setFailures(fails);
      timer = setTimeout(loop, nextDelay(fails));
    };
    timer = setTimeout(loop, nextDelay(0));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, filterKey, reload, highlight, fetcher]);

  const resume = useCallback(() => {
    resetIdle();
    setNow(Date.now());
    const { pending: held } = state.current;
    if (paginated || more) {
      highlight(held.map(rowKey));
      setPending([]);
      setMore(false);
      reload();
    } else if (held.length) {
      const merged = mergeRows(state.current.rows ?? [], held);
      state.current.rows = merged.rows;
      setRows(merged.rows);
      highlight(merged.added);
      setPending([]);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [paginated, more, reload, highlight, resetIdle]);

  return { rows: enabled ? rows : null, paused, pending: pending.length, more, fresh, failing: failures > 0, resume };
}
