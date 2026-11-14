import { describe, expect, it } from "vitest";
import { errorGroups, failureInvocations, invocations, throttledGroup } from "../fixtures/traces.js";
import { formatErrorGroups, formatInvocations } from "./format-lists.js";

describe("list formatters", () => {
  it("renders one line per invocation", () => {
    expect(formatInvocations(invocations)).toMatchSnapshot();
  });

  it("renders error groups", () => {
    expect(formatErrorGroups(errorGroups)).toMatchSnapshot();
  });

  it("renders the Throttled group without a trace", () => {
    expect(formatErrorGroups([throttledGroup])).toBe(
      "31× orders-processQueue · Throttled: Lambda rejected these invocations, so they never reached the function and there is no trace · first 2026-11-14T11:40:00Z · last 2026-11-14T11:52:00Z",
    );
  });

  it("labels failures outside the handler and says when there is no trace", () => {
    const [init, oom] = formatInvocations(failureInvocations).split("\n");
    expect(init).toContain("· Init failed · Runtime.ImportModuleError: Error: Cannot find module 'left-pad'");
    expect(init).toContain("no request");
    expect(init).toContain("the runtime never started the handler");
    expect(oom).toContain("· Out of memory · Runtime.OutOfMemory");
    expect(oom).toContain("process died before the tracer could report");
    expect(formatErrorGroups(errorGroups.slice(2))).toContain("Init failed · Runtime.ImportModuleError");
  });

  it("says how long an in-progress invocation has been running, or that no completion was recorded", () => {
    const start = Date.UTC(2026, 10, 14, 12, 0, 0);
    const running = {
      ...invocations[0],
      status: "in_progress" as const,
      ts: new Date(start).toISOString(),
      function: "import-worker",
      cold_start: false,
      deadline: new Date(start + 900_000).toISOString(),
      last_seen: new Date(start + 5000).toISOString(),
    };
    expect(formatInvocations([running], undefined, start + 134_000)).toBe(
      `2026-11-14T12:00:00Z RUNNING import-worker running for 2m 14s (in progress) · trace ${running.trace_id}`,
    );
    expect(formatInvocations([running], undefined, start + 960_000)).toBe(
      `2026-11-14T12:00:00Z NO COMPLETION import-worker no completion recorded · deadline 2026-11-14T12:15:00Z passed without a final record · trace ${running.trace_id}`,
    );
  });

  it("says so when empty", () => {
    expect(formatInvocations([])).toBe("No invocations found.");
    expect(formatErrorGroups([])).toBe("No errors found.");
  });
});
