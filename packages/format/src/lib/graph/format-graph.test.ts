import { describe, expect, it } from "vitest";
import { checkoutOk, queueFailed } from "../fixtures/traces.js";
import { formatServiceGraph } from "./format-graph.js";

describe("formatServiceGraph", () => {
  it("lists the edges of a successful trace", () => {
    expect(formatServiceGraph(checkoutOk)).toMatchSnapshot();
  });

  it("folds repeated calls into one node and marks failures", () => {
    expect(formatServiceGraph(queueFailed)).toMatchSnapshot();
  });
});
