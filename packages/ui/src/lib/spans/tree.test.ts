import { describe, expect, it } from "vitest";
import { buildWaterfall, filterInvocation, findRootInvocation } from "./tree";
import type { Span } from "./types";

const span = (id: string, parent: string, startMs: number, duration: number, invocation = false): Span => ({
  span_id: id,
  parent_span_id: parent,
  name: id,
  kind: "CLIENT",
  service: "fn",
  start: new Date(1_000_000 + startMs).toISOString(),
  end: new Date(1_000_000 + startMs + duration).toISOString(),
  duration_ms: duration,
  status_code: "OK",
  status_message: "",
  attributes: invocation ? { "ivy.invocation": "true" } : {},
  resource: {},
  events: [],
});

describe("buildWaterfall", () => {
  const spans = [
    span("root", "", 0, 100, true),
    span("b", "root", 50, 10),
    span("a", "root", 10, 20),
    span("a1", "a", 12, 5),
    span("inv2", "b", 55, 40, true),
    span("c", "inv2", 60, 10),
    span("orphan", "missing", 90, 10),
  ];

  it("orders depth-first by start time and computes offsets", () => {
    const { rows, totalMs } = buildWaterfall(spans);
    expect(totalMs).toBe(100);
    expect(rows.map((r) => [r.span.span_id, r.depth])).toEqual([
      ["root", 0],
      ["a", 1],
      ["a1", 2],
      ["b", 1],
      ["inv2", 2],
      ["c", 3],
      ["orphan", 0],
    ]);
    const a = rows.find((r) => r.span.span_id === "a")!;
    expect(a.offsetPct).toBe(10);
    expect(a.widthPct).toBe(20);
  });

  it("assigns spans to their nearest invocation", () => {
    const { rows } = buildWaterfall(spans);
    const owner = Object.fromEntries(rows.map((r) => [r.span.span_id, r.invocationId]));
    expect(owner).toMatchObject({ root: "root", a1: "root", b: "root", inv2: "inv2", c: "inv2" });
    const filtered = filterInvocation(rows, "inv2");
    expect(filtered.map((r) => [r.span.span_id, r.depth])).toEqual([
      ["inv2", 0],
      ["c", 1],
    ]);
  });

  it("handles empty traces and finds the root invocation", () => {
    expect(buildWaterfall([]).rows).toEqual([]);
    expect(findRootInvocation(spans)?.span_id).toBe("root");
  });
});
