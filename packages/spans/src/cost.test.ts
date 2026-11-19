import { describe, expect, it } from "vitest";
import { formatUsd, invocationCost, lambdaArch } from "./cost.js";
import type { Span } from "./types.js";

const span = (attributes: Record<string, string>, resource: Record<string, string> = {}): Span => ({
  span_id: "r",
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
  resource,
  events: [],
});

describe("invocationCost", () => {
  it("prices GB-seconds plus the request on x86_64", () => {
    const cost = invocationCost(span({ "ivy.billed_duration_ms": "900000", "ivy.memory_size_mb": "2048" }, { "host.arch": "amd64" }));
    expect(cost).toMatchObject({ arch: "x86_64", archKnown: true, memoryMb: 2048, billedMs: 900000 });
    expect(cost!.usd).toBeCloseTo(2 * 900 * 0.0000166667 + 0.0000002, 10);
  });

  it("uses the arm64 rate when the function runs on Graviton", () => {
    const cost = invocationCost(span({ "ivy.billed_duration_ms": "1000", "ivy.memory_size_mb": "1024" }, { "host.arch": "arm64" }));
    expect(cost!.usd).toBeCloseTo(0.0000133334 + 0.0000002, 12);
  });

  it("assumes x86_64 when the architecture is unknown, and takes memory from the resource", () => {
    const cost = invocationCost(span({ "ivy.billed_duration_ms": "1000" }, { "faas.max_memory": String(512 * 1024 * 1024) }));
    expect(cost).toMatchObject({ arch: "x86_64", archKnown: false, memoryMb: 512 });
  });

  it("is null without billed duration or memory", () => {
    expect(invocationCost(span({ "ivy.memory_size_mb": "128" }))).toBeNull();
    expect(invocationCost(span({ "ivy.billed_duration_ms": "100" }))).toBeNull();
  });
});

describe("lambdaArch", () => {
  it.each([
    ["amd64", "x86_64"],
    ["x86_64", "x86_64"],
    ["arm64", "arm64"],
    [undefined, null],
  ])("%s → %s", (arch, expected) => {
    expect(lambdaArch(arch === undefined ? {} : { "host.arch": arch })).toBe(expected);
  });
});

describe("formatUsd", () => {
  it.each([
    [0.0000052083, "$0.0000052"],
    [0.0300002, "$0.030"],
    [0.5, "$0.50"],
    [1.254, "$1.25"],
    [30000.2, "$30,000"],
  ])("%s → %s", (usd, expected) => {
    expect(formatUsd(usd)).toBe(expected);
  });
});
