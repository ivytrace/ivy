import { describe, expect, it } from "vitest";
import { checkoutOk, queueFailed, supportBot } from "../fixtures/traces.js";
import { formatServiceGraph } from "./format-graph.js";

describe("formatServiceGraph", () => {
  it("lists the edges of a successful trace", () => {
    expect(formatServiceGraph(checkoutOk)).toMatchSnapshot();
  });

  it("shows LLM providers as nodes", () => {
    const text = formatServiceGraph(supportBot);
    expect(text).toMatchSnapshot();
    expect(text).toContain("support-answerTicket → OpenAI [LLM generateText, 2 calls,");
    expect(text).toContain("support-answerTicket → Anthropic [LLM streamText,");
    expect(text).toContain("support-answerTicket → orders-prod [DynamoDB GetItem,");
  });

  it("folds repeated calls into one node and marks failures", () => {
    expect(formatServiceGraph(queueFailed)).toMatchSnapshot();
  });
});
