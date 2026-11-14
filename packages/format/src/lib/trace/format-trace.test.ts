import { describe, expect, it } from "vitest";
import { checkoutFailed, checkoutOk, plainOtel, queueFailed, supportBot, supportBotGenAi } from "../fixtures/traces.js";
import { estimateTokens } from "../text/text.js";
import { formatTrace } from "./format-trace.js";

describe("formatTrace", () => {
  it("renders a failed API invocation", () => {
    expect(formatTrace(checkoutFailed)).toMatchSnapshot();
  });

  it("renders a successful invocation", () => {
    expect(formatTrace(checkoutOk)).toMatchSnapshot();
  });

  it("collapses repeated calls and shows payloads cut at the source", () => {
    expect(formatTrace(queueFailed)).toMatchSnapshot();
  });

  it("renders traces without an Ivy invocation span", () => {
    expect(formatTrace(plainOtel)).toMatchSnapshot();
  });

  it("summary detail leaves out payloads and info logs", () => {
    const text = formatTrace(checkoutFailed, { detail: "summary" });
    expect(text).toMatchSnapshot();
    expect(text).not.toContain("req:");
    expect(text).not.toContain("Creating order");
  });

  it("full detail shows every payload and headers, without collapsing", () => {
    expect(formatTrace(checkoutFailed, { detail: "full", maxTokens: 0 })).toContain("req headers:");
    const text = formatTrace(queueFailed, { detail: "full", maxTokens: 0 });
    expect(text).not.toContain("×8");
    expect(text.match(/DynamoDB\.GetItem/g)).toHaveLength(8);
  });

  it("keeps redaction markers", () => {
    const text = formatTrace(checkoutFailed, { detail: "full", maxTokens: 0 });
    expect(text).toContain('"authorization":"[redacted]"');
    expect(text).not.toContain("Bearer");
  });

  it("fits the token budget and keeps the failures", () => {
    const text = formatTrace(checkoutFailed, { detail: "full", maxTokens: 250 });
    expect(estimateTokens(text)).toBeLessThanOrEqual(250);
    expect(text).toContain("checkout-createOrder [invocation]");
    expect(text).toContain("! TypeError: Cannot read properties of undefined (reading 'id')");
    expect(text).toMatchSnapshot();
  });

  it("renders LLM spans with model, tokens, time to first token, tool calls, prompt and response", () => {
    const text = formatTrace(supportBot, { maxTokens: 0 });
    expect(text).toMatchSnapshot();
    expect(text).toContain("3 LLM calls 1877→103 tok");
    expect(text).toContain("ai.generateText.doGenerate gpt-4o-mini 812→24 tok tool:getOrder");
    expect(text).toContain("ai.streamText.doStream claude-haiku-4-5 164→38 tok (ttft 318ms)");
    expect(text).toMatch(/ai\.toolCall getOrder {2}ok\n.*args: \{"orderId":"ord_8812"\}/);
    expect(formatTrace(supportBot, { detail: "summary" })).not.toContain("prompt:");
    expect(formatTrace(supportBot, { detail: "full", maxTokens: 0 })).toMatch(/system: You are the support assistant/);
  });

  it("renders GenAI semantic-convention spans", () => {
    const text = formatTrace(supportBotGenAi, { maxTokens: 0 });
    expect(text).toMatchSnapshot();
    expect(text).toContain("chat gpt-4o-mini 812→24 tok tool:getOrder");
    expect(text).toContain("execute_tool getOrder");
  });

  it("trims payloads to payloadChars", () => {
    const text = formatTrace(checkoutFailed, { payloadChars: 40, maxTokens: 0 });
    for (const line of text.split("\n").filter((l) => /\b(req|res): /.test(l))) {
      expect(line.replace(/^.*?(req|res): /, "").length).toBeLessThanOrEqual(40 + 20);
    }
  });
});
