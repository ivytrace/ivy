import { describe, expect, it } from "vitest";
import { collapsedBaseName, collapsedCalls, collapsedInfo, droppedSpans, droppedSpansLabel, formatCount } from "./collapsed.js";
import { describeSpan } from "./services.js";
import type { Span } from "./types.js";

const span = (name: string, attributes: Record<string, string>): Span => ({
  span_id: "s1",
  parent_span_id: "root",
  name,
  kind: "CLIENT",
  service: "checkout-importOrders",
  start: "2026-11-14T12:00:00.240Z",
  end: "2026-11-14T12:00:09.300Z",
  duration_ms: 9060,
  status_code: "UNSET",
  status_message: "",
  attributes,
  resource: {},
  events: [],
});

const summary = span("DynamoDB.PutItem × 1,184", {
  "rpc.system": "aws-api",
  "rpc.service": "DynamoDB",
  "rpc.method": "PutItem",
  "aws.dynamodb.table_names": '["orders"]',
  "ivy.collapsed.count": "1184",
  "ivy.collapsed.duration_total_ms": "6130.4",
  "ivy.collapsed.duration_max_ms": "29.8",
  "ivy.collapsed.duration_min_ms": "2.1",
  "ivy.collapsed.errors": "1",
  "ivy.collapsed.kept": "9",
  "ivy.collapsed.signature": "DynamoDB.PutItem orders",
});

describe("collapsedInfo", () => {
  it("reads the summary attributes", () => {
    const info = collapsedInfo(summary)!;
    expect(info).toMatchObject({ count: 1184, totalMs: 6130.4, maxMs: 29.8, minMs: 2.1, errors: 1, kept: 9, signature: "DynamoDB.PutItem orders" });
    expect(info.avgMs).toBeCloseTo(5.18, 2);
  });

  it("is undefined for ordinary spans", () => {
    expect(collapsedInfo(span("DynamoDB.PutItem", { "rpc.method": "PutItem" }))).toBeUndefined();
    expect(collapsedInfo(span("x", { "ivy.collapsed.count": "0" }))).toBeUndefined();
  });

  it("strips the count suffix from the name", () => {
    expect(collapsedBaseName("DynamoDB.PutItem × 1,184")).toBe("DynamoDB.PutItem");
    expect(collapsedBaseName("GET api.example.com × 312")).toBe("GET api.example.com");
    expect(collapsedBaseName("DynamoDB.PutItem")).toBe("DynamoDB.PutItem");
  });

  it("is described like the calls it stands for", () => {
    const d = describeSpan(summary);
    expect(d.operation).toBe("PutItem");
    expect(d.target).toBe("orders");
    expect(d.collapsed?.count).toBe(1184);
    const http = describeSpan(
      span("GET api.example.com × 312", {
        "http.request.method": "GET",
        "server.address": "api.example.com",
        "http.route": "/products/{sku}",
        "ivy.collapsed.count": "312",
      }),
    );
    expect(http.operation).toBe("GET");
    expect(http.target).toBe("api.example.com/products/{sku}");
  });
});

describe("droppedSpans", () => {
  it("reads the count and reason from the invocation's attributes", () => {
    const dropped = droppedSpans({ "ivy.dropped_spans": "37", "ivy.dropped_spans.reason": "span limit" })!;
    expect(dropped).toEqual({ count: 37, reason: "span limit" });
    expect(droppedSpansLabel(dropped)).toBe("37 spans omitted (span limit)");
    expect(droppedSpansLabel({ count: 1 })).toBe("1 span omitted");
    expect(droppedSpansLabel({ count: 1250, reason: "span limit, export failed" })).toBe("1,250 spans omitted (span limit, export failed)");
  });

  it("is undefined without omitted spans", () => {
    expect(droppedSpans({})).toBeUndefined();
    expect(droppedSpans({ "ivy.dropped_spans": "0" })).toBeUndefined();
  });

  it("reads the collapsed call total and formats counts", () => {
    expect(collapsedCalls({ "ivy.collapsed_calls": "1496" })).toBe(1496);
    expect(collapsedCalls({})).toBeUndefined();
    expect(formatCount(1184)).toBe("1,184");
  });
});
