import { describe, expect, it } from "vitest";
import { errorGroups, invocations, throttledGroup } from "../fixtures/traces.js";
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

  it("says so when empty", () => {
    expect(formatInvocations([])).toBe("No invocations found.");
    expect(formatErrorGroups([])).toBe("No errors found.");
  });
});
