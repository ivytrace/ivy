import { describe, expect, it } from "vitest";
import { errorGroups, invocations } from "../fixtures/traces.js";
import { formatErrorGroups, formatInvocations } from "./format-lists.js";

describe("list formatters", () => {
  it("renders one line per invocation", () => {
    expect(formatInvocations(invocations)).toMatchSnapshot();
  });

  it("renders error groups", () => {
    expect(formatErrorGroups(errorGroups)).toMatchSnapshot();
  });

  it("says so when empty", () => {
    expect(formatInvocations([])).toBe("No invocations found.");
    expect(formatErrorGroups([])).toBe("No errors found.");
  });
});
