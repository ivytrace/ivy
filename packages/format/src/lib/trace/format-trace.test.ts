import { describe, expect, it } from "vitest";
import { checkoutFailed, checkoutOk, importWorker, initFailed, oomCrashed, plainOtel, queueFailed, supportBot, supportBotGenAi, ticketTriage } from "../fixtures/traces.js";
import { estimateTokens } from "../text/text.js";
import * as AI from "../fixtures/ai-traces.js";
import { formatTrace } from "./format-trace.js";
import { spanLabel } from "./label.js";

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

  it("labels an init failure, says why there is no trace, and shows the log tail", () => {
    const text = formatTrace(initFailed);
    expect(text).toMatchSnapshot();
    expect(text).toContain("ERROR (Init failed)");
    expect(text).toContain("no request");
    expect(text).toContain("the runtime never started the handler");
    expect(text).toContain("Cannot find module 'left-pad'");
    expect(text).toContain("init 213ms");
  });

  it("labels an out-of-memory crash with memory used against the limit and billed duration", () => {
    const text = formatTrace(oomCrashed);
    expect(text).toMatchSnapshot();
    expect(text).toContain("ERROR (Out of memory)");
    expect(text).toContain("128 MB used of 128 MB");
    expect(text).toContain("billed 2381ms");
    expect(text).toContain("JavaScript heap out of memory");
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

  it("renders direct Amazon Bedrock calls as LLM calls", () => {
    const text = formatTrace(ticketTriage, { maxTokens: 0 });
    expect(text).toMatchSnapshot();
    expect(text).toContain("3 LLM calls 1125→128 tok");
    expect(text).toContain("BedrockRuntime.InvokeModel claude-haiku-5-5 412→38 tok");
    expect(text).toContain("BedrockRuntime.Converse nova-lite 655→61 tok");
    expect(text).toContain("BedrockRuntime.InvokeModel nova-lite 58→29 tok");
    expect(text).not.toMatch(/Bedrock\S*\.eu-west-1/);
  });

  it("labels Bedrock spans captured at the HTTP level by older layers", () => {
    const span = { ...ticketTriage.spans[1], name: "POST bedrock-runtime.eu-west-1.amazonaws.com", attributes: AI.bedrockAttributes.invokeModelHttp };
    expect(spanLabel(span)).toBe("BedrockRuntime.InvokeModel claude-haiku-5-5 412→38 tok");
  });

  it("trims payloads to payloadChars", () => {
    const text = formatTrace(checkoutFailed, { payloadChars: 40, maxTokens: 0 });
    for (const line of text.split("\n").filter((l) => /\b(req|res): /.test(l))) {
      expect(line.replace(/^.*?(req|res): /, "").length).toBeLessThanOrEqual(40 + 20);
    }
  });

  it("renders summary spans of collapsed calls and the spans omitted at the limit", () => {
    const text = formatTrace(importWorker, { maxTokens: 0 });
    expect(text).toMatchSnapshot();
    expect(text).toContain("37 spans omitted (span limit) · 1,496 similar calls collapsed into summary spans");
    expect(text).toContain(
      "DynamoDB.PutItem orders × 1,184 (first→last 9060ms, total 6130ms, avg 5.2ms, min 2.1ms, max 29.8ms, 1 error, 9 kept)",
    );
    expect(text).toContain("GET api.example.com/products/{sku} × 312 (");
    expect(text).toContain("DynamoDB.PutItem orders → 400  ERROR");
  });
});
