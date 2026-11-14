import { describe, expect, it } from "vitest";
import { COMPLETION_GRACE_MS, formatElapsed, inProgressState, inProgressText, mergeInProgressSpans } from "./in-progress.js";
import type { Span } from "./types.js";

const span = (id: string, attributes: Record<string, string>, end = "2026-11-14T12:00:05.000Z"): Span => ({
  span_id: id,
  parent_span_id: "",
  name: "fn",
  kind: "INTERNAL",
  service: "fn",
  start: "2026-11-14T12:00:00.000Z",
  end,
  duration_ms: Date.parse(end) - Date.parse("2026-11-14T12:00:00.000Z"),
  status_code: "UNSET",
  status_message: "",
  attributes,
  resource: {},
  events: [],
});

describe("mergeInProgressSpans", () => {
  it("drops provisional records once the final span with the same ID is there", () => {
    const provisional = span("r", { "ivy.invocation": "true", "ivy.in_progress": "true" });
    const final = span("r", { "ivy.invocation": "true" }, "2026-11-14T12:00:07.000Z");
    const child = { ...span("c", {}), parent_span_id: "r" };
    expect(mergeInProgressSpans([provisional, final, child])).toEqual([final, child]);
  });

  it("keeps the newest provisional record when nothing replaced it", () => {
    const first = span("r", { "ivy.in_progress": "true" }, "2026-11-14T12:00:05.000Z");
    const refresh = span("r", { "ivy.in_progress": "true" }, "2026-11-14T12:01:05.000Z");
    expect(mergeInProgressSpans([first, refresh])).toEqual([refresh]);
    const plain = [span("x", {})];
    expect(mergeInProgressSpans(plain)).toBe(plain);
  });
});

describe("inProgressState and text", () => {
  const deadline = Date.UTC(2026, 10, 14, 12, 15);
  it("is running until the deadline plus a grace", () => {
    expect(inProgressState(deadline, deadline - 1)).toBe("running");
    expect(inProgressState(deadline, deadline + COMPLETION_GRACE_MS)).toBe("running");
    expect(inProgressState(deadline, deadline + COMPLETION_GRACE_MS + 1)).toBe("no_completion");
    expect(inProgressState(null, deadline * 2)).toBe("running");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(850)).toBe("850ms");
    expect(formatElapsed(14_200)).toBe("14s");
    expect(formatElapsed(134_000)).toBe("2m 14s");
    expect(formatElapsed(3_780_000)).toBe("1h 3m");
    const start = deadline - 600_000;
    expect(inProgressText(start, deadline, start + 134_000)).toBe("running for 2m 14s (in progress)");
    expect(inProgressText(start, deadline, deadline + 60_000)).toBe("no completion recorded");
  });
});
