import { describe, expect, it } from "vitest";
import type { Invocation } from "../api/types";
import {
  IDLE_PAUSE_MS,
  LIVE_INTERVAL_MS,
  MAX_BACKOFF_MS,
  MIN_INTERVAL_MS,
  mergeRows,
  nextDelay,
  pauseReason,
  refreshIds,
  sinceCursor,
  stopsPolling,
} from "./live";

const row = (id: string, ts: string, extra: Partial<Invocation> = {}): Invocation => ({
  trace_id: `t-${id}`,
  span_id: id,
  ts,
  function: "checkout-createOrder",
  region: "eu-west-1",
  status: "ok",
  duration_ms: 12,
  cold_start: false,
  request_id: `req-${id}`,
  trigger: "aws:apigatewayv2",
  http_method: null,
  http_path: null,
  http_status: null,
  error_type: null,
  error_message: null,
  memory_used_mb: null,
  memory_limit_mb: null,
  failure_phase: null,
  failure_kind: null,
  synthetic: false,
  init_duration_ms: null,
  ...extra,
});

describe("sinceCursor", () => {
  it("starts a second before the newest row, whatever the order", () => {
    const rows = [row("a", "2026-11-14T12:00:05.000Z"), row("b", "2026-11-14T12:00:09.500Z"), row("c", "2026-11-14T11:59:00.000Z")];
    expect(sinceCursor(rows)).toBe("2026-11-14T12:00:08.500Z");
    expect(sinceCursor([])).toBeNull();
  });
});

describe("mergeRows", () => {
  it("prepends new rows newest first and reports them", () => {
    const shown = [row("a", "2026-11-14T12:00:05.000Z")];
    const { rows, added } = mergeRows(shown, [row("b", "2026-11-14T12:00:06.000Z"), row("c", "2026-11-14T12:00:08.000Z")]);
    expect(rows.map((r) => r.span_id)).toEqual(["c", "b", "a"]);
    expect(added).toEqual(["t-c:c", "t-b:b"]);
  });

  it("dedupes overlapping rows and replaces in-progress rows in place", () => {
    const running = row("a", "2026-11-14T12:00:05.000Z", { status: "in_progress", deadline: "2026-11-14T12:15:05.000Z" });
    const shown = [row("b", "2026-11-14T12:00:06.000Z"), running];
    const done = row("a", "2026-11-14T12:00:05.000Z", { duration_ms: 7012 });
    const { rows, added } = mergeRows(shown, [shown[0], done]);
    expect(rows.map((r) => r.span_id)).toEqual(["b", "a"]);
    expect(rows[1].status).toBe("ok");
    expect(rows[1].duration_ms).toBe(7012);
    expect(added).toEqual([]);
  });

  it("keeps the list bounded and returns the same list when nothing came", () => {
    const shown = [row("a", "2026-11-14T12:00:05.000Z")];
    expect(mergeRows(shown, []).rows).toBe(shown);
    expect(mergeRows(shown, [row("b", "2026-11-14T12:00:06.000Z")], 1).rows.map((r) => r.span_id)).toEqual(["b"]);
  });

  it("refreshes only in-progress rows", () => {
    const rows = [row("a", "2026-11-14T12:00:05.000Z", { status: "in_progress" }), row("b", "2026-11-14T12:00:06.000Z")];
    expect(refreshIds(rows)).toEqual(["a"]);
  });
});

describe("pauseReason", () => {
  const active = { hidden: false, idleMs: 0, paginated: false, scrolled: false };
  it("pauses on a hidden tab and after 15 minutes idle, which stop polling", () => {
    expect(pauseReason(active)).toBeNull();
    expect(pauseReason({ ...active, hidden: true, scrolled: true })).toBe("hidden");
    expect(pauseReason({ ...active, idleMs: IDLE_PAUSE_MS - 1 })).toBeNull();
    expect(pauseReason({ ...active, idleMs: IDLE_PAUSE_MS })).toBe("idle");
    expect(stopsPolling("hidden") && stopsPolling("idle")).toBe(true);
  });

  it("holds new rows back while scrolled down or on another page", () => {
    expect(pauseReason({ ...active, scrolled: true })).toBe("scrolled");
    expect(pauseReason({ ...active, paginated: true, scrolled: true })).toBe("paginated");
    expect(stopsPolling("scrolled") || stopsPolling("paginated") || stopsPolling(null)).toBe(false);
  });
});

describe("nextDelay", () => {
  it("polls every 3 s and backs off on errors up to 30 s", () => {
    expect(nextDelay(0)).toBe(LIVE_INTERVAL_MS);
    expect(nextDelay(1)).toBe(6000);
    expect(nextDelay(2)).toBe(12_000);
    expect(nextDelay(10)).toBe(MAX_BACKOFF_MS);
  });

  it("never polls faster than every 2 s", () => {
    expect(nextDelay(0, 500)).toBe(MIN_INTERVAL_MS);
    expect(nextDelay(0, 0)).toBe(MIN_INTERVAL_MS);
  });
});
