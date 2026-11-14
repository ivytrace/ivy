import { describe, expect, it } from "vitest";
import { checkoutFailed, checkoutOk, initFailed, oomCrashed, plainOtel, queueFailed } from "../fixtures/traces.js";
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

  it("trims payloads to payloadChars", () => {
    const text = formatTrace(checkoutFailed, { payloadChars: 40, maxTokens: 0 });
    for (const line of text.split("\n").filter((l) => /\b(req|res): /.test(l))) {
      expect(line.replace(/^.*?(req|res): /, "").length).toBeLessThanOrEqual(40 + 20);
    }
  });
});
