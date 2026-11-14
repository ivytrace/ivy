import { describe, expect, it } from "vitest";
import { failureKind, failureLabel, invocationResources, mergeUpdateSpans, missingTraceNote, spanFailureKind } from "./failures.js";
import type { Span } from "./types.js";

const span = (id: string, attributes: Record<string, string>, extra: Partial<Span> = {}): Span => ({
  span_id: id,
  parent_span_id: "",
  name: "fn",
  kind: "INTERNAL",
  service: "fn",
  start: "2026-11-14T12:00:00.000Z",
  end: "2026-11-14T12:00:00.100Z",
  duration_ms: 100,
  status_code: "UNSET",
  status_message: "",
  attributes,
  resource: {},
  events: [],
  ...extra,
});

describe("failureKind", () => {
  it.each([
    ["Runtime.ImportModuleError", "init", "init_failed"],
    ["Runtime.HandlerNotFound", undefined, "init_failed"],
    ["Runtime.OutOfMemory", "invoke", "out_of_memory"],
    ["Sandbox.Timedout", "invoke", "timed_out"],
    ["Timeout", undefined, "timed_out"],
    ["Runtime.ExitError", "invoke", "crashed"],
    ["Runtime.Something", "invoke", "crashed"],
    ["TypeError", undefined, null],
    [null, null, null],
  ] as const)("%s / %s → %s", (type, phase, kind) => {
    expect(failureKind(type, phase)).toBe(kind);
  });

  it("labels kinds and only looks at failed spans", () => {
    expect(failureLabel("init_failed")).toBe("Init failed");
    expect(failureLabel("out_of_memory")).toBe("Out of memory");
    expect(failureLabel(null)).toBeNull();
    expect(spanFailureKind(span("a", { "error.type": "Runtime.OutOfMemory" }))).toBeNull();
    expect(spanFailureKind(span("a", { "error.type": "Runtime.OutOfMemory" }, { status_code: "ERROR" }))).toBe("out_of_memory");
  });

  it("explains missing traces", () => {
    expect(missingTraceNote("init_failed", true)).toMatch(/never started/);
    expect(missingTraceNote("out_of_memory", true)).toMatch(/process died/);
    expect(missingTraceNote("timed_out", false)).toBeNull();
    expect(missingTraceNote(null, false)).toBeNull();
  });
});

describe("mergeUpdateSpans", () => {
  it("applies update spans to the span with the same ID and drops them", () => {
    const root = span("r", { "ivy.invocation": "true", "faas.invocation_id": "req-1" });
    const child = span("c", { "rpc.system": "aws-api" }, { parent_span_id: "r" });
    const update = span("r", { "ivy.update": "true", "ivy.billed_duration_ms": "101", "ivy.memory_max_used_mb": "84" });
    const merged = mergeUpdateSpans([root, update, child]);
    expect(merged.map((s) => s.span_id)).toEqual(["r", "c"]);
    expect(merged[0].attributes).toEqual({
      "ivy.invocation": "true",
      "faas.invocation_id": "req-1",
      "ivy.billed_duration_ms": "101",
      "ivy.memory_max_used_mb": "84",
    });
    expect(merged[1]).toBe(child);
  });

  it("drops updates whose span is not there and leaves lists without updates untouched", () => {
    const list = [span("x", {})];
    expect(mergeUpdateSpans(list)).toBe(list);
    expect(mergeUpdateSpans([span("x", {}), span("gone", { "ivy.update": "true" })]).map((s) => s.span_id)).toEqual(["x"]);
  });
});

describe("invocationResources", () => {
  it("prefers report figures and falls back to the tracer and resource", () => {
    const reported = span("r", { "ivy.memory_max_used_mb": "120", "ivy.memory_size_mb": "128", "ivy.billed_duration_ms": "250", "ivy.init_duration_ms": "212.4" });
    expect(invocationResources(reported)).toEqual({ memoryUsedMb: 120, memoryLimitMb: 128, billedDurationMs: 250, initDurationMs: 212.4, restoreDurationMs: null });
    const tracerOnly = span("r", { "ivy.memory_used_mb": "61.5" }, { resource: { "faas.max_memory": String(256 * 1048576) } });
    expect(invocationResources(tracerOnly)).toMatchObject({ memoryUsedMb: 61.5, memoryLimitMb: 256, billedDurationMs: null });
  });
});
