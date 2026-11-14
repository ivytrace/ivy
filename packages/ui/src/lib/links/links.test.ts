import { describe, expect, it } from "vitest";
import { invocationsLink, traceLink } from "./links";

describe("links", () => {
  it("builds trace and filtered invocation links", () => {
    expect(traceLink("abc")).toBe("/traces/abc");
    expect(traceLink("abc", "s1")).toBe("/traces/abc?invocation=s1");
    expect(invocationsLink()).toBe("/invocations");
    expect(invocationsLink({ function: "a b", status: "error", q: "x'y" })).toBe(
      "/invocations?function=a+b&status=error&q=x%27y",
    );
  });
});
