import { describe, expect, it } from "vitest";
import { checkoutOk, queueFailed, supportBot, ticketTriage } from "../fixtures/traces.js";
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

  it("shows direct Bedrock calls as one node per model maker", () => {
    const text = formatServiceGraph(ticketTriage);
    expect(text).toMatchSnapshot();
    expect(text).toContain("support-triageTicket → Bedrock · Anthropic [LLM InvokeModel,");
    expect(text).toContain("support-triageTicket → Bedrock · Amazon [LLM Converse, 2 calls,");
  });

  it("folds repeated calls into one node and marks failures", () => {
    expect(formatServiceGraph(queueFailed)).toMatchSnapshot();
  });
});
