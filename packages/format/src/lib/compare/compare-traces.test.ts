import { describe, expect, it } from "vitest";
import { checkoutFailed, checkoutOk } from "../fixtures/traces.js";
import { compareTraces } from "./compare-traces.js";

describe("compareTraces", () => {
  it("diffs a failing invocation against a successful one", () => {
    const text = compareTraces(checkoutFailed, checkoutOk, { labels: ["failing", "baseline"] });
    expect(text).toMatchSnapshot();
    expect(text).toContain("- only in baseline: DynamoDB.PutItem checkout-orders");
    expect(text).toContain("~ POST api.stripe.com/v1/payment_intents");
    expect(text).toContain("res.error:");
  });

  it("reports identical traces as matching calls", () => {
    const text = compareTraces(checkoutOk, checkoutOk);
    expect(text).toContain("0 only in A, 0 only in B");
    expect(text).not.toMatch(/^\s+~ /m);
  });
});
