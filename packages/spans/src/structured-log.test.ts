import { describe, expect, it } from "vitest";
import { normalizeLevel, parseStructuredLog, sharedFields, structuredLogText } from "./structured-log.js";

const request = JSON.stringify({
  level: "INFO",
  name: "Request",
  message: "PUT /orders/42",
  awsRegion: "eu-central-1",
  functionName: "api-production-main",
  functionVersion: "$LATEST",
  functionMemorySize: "3008",
  stage: "production",
  buildId: "ff08b025",
  requestId: "31a694af",
  method: "PUT",
  path: "/orders/42",
});
const response = JSON.stringify({
  level: "INFO",
  name: "Response",
  message: "PUT /orders/42 (200) - 32ms",
  awsRegion: "eu-central-1",
  stage: "production",
  buildId: "ff08b025",
  requestId: "31a694af",
  status: 200,
  method: "PUT",
  path: "/orders/42",
  duration: 32,
});

describe("structured logs", () => {
  it("splits a JSON line into level, name, message and the fields worth reading", () => {
    const log = parseStructuredLog(request)!;
    expect(log.level).toBe("info");
    expect(log.name).toBe("Request");
    expect(log.message).toBe("PUT /orders/42");
    expect(log.fields).toEqual([
      ["stage", "production"],
      ["buildId", "ff08b025"],
      ["method", "PUT"],
      ["path", "/orders/42"],
    ]);
    expect(log.data.requestId).toBe("31a694af");
  });

  it("reads pino-style lines: numeric levels and msg", () => {
    const log = parseStructuredLog('{"level":50,"time":1731580000000,"pid":8,"hostname":"x","msg":"boom","orderId":"o-1"}')!;
    expect(log).toMatchObject({ level: "error", message: "boom", fields: [["orderId", "o-1"]] });
  });

  it("leaves anything that isn't a JSON object alone", () => {
    for (const line of ["plain text", "[1,2]", '{"broken":', "{not json}", '"string"', "  "]) expect(parseStructuredLog(line)).toBeNull();
  });

  it("normalizes level names and numbers", () => {
    expect(["WARNING", "Fatal", "trace", "notice", 30, 45, 60, "nope"].map(normalizeLevel)).toEqual([
      "warn",
      "error",
      "debug",
      "info",
      "info",
      "warn",
      "error",
      undefined,
    ]);
  });

  it("finds the fields every line shares", () => {
    const logs = [parseStructuredLog(request), null, parseStructuredLog(response)];
    expect(sharedFields(logs)).toEqual([
      ["stage", "production"],
      ["buildId", "ff08b025"],
      ["method", "PUT"],
      ["path", "/orders/42"],
    ]);
    expect(sharedFields([parseStructuredLog(request)])).toEqual([]);
  });

  it("writes a line as compact text", () => {
    expect(structuredLogText(parseStructuredLog(response)!)).toBe(
      "Response: PUT /orders/42 (200) - 32ms stage=production buildId=ff08b025 status=200 method=PUT path=/orders/42 duration=32",
    );
  });
});
