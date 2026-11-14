import { describe, expect, it } from "vitest";
import { describeSpan, getException, getLogs, parsePayload, parseStringArray } from "./services.js";
import type { Span } from "./types.js";

const span = (overrides: Partial<Span> & { attributes?: Record<string, string> }): Span => ({
  span_id: "s1",
  parent_span_id: "root",
  name: "x",
  kind: "CLIENT",
  service: "fn",
  start: "2026-11-14T12:00:00.000Z",
  end: "2026-11-14T12:00:00.010Z",
  duration_ms: 10,
  status_code: "OK",
  status_message: "",
  resource: {},
  events: [],
  ...overrides,
  attributes: overrides.attributes ?? {},
});

const aws = (service: string, method: string, extra: Record<string, string> = {}) => ({
  "rpc.system": "aws-api",
  "rpc.service": service,
  "rpc.method": method,
  ...extra,
});

describe("parsePayload", () => {
  it("parses JSON and strips the truncation marker", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
    expect(parsePayload('"abc"')).toBe("abc");
    expect(parsePayload('{"a":1}…[truncated 120 bytes]')).toEqual({ a: 1 });
    expect(parsePayload('{"a":"long…[truncated 9 bytes]')).toBe('{"a":"long…[truncated 9 bytes]');
    expect(parsePayload("")).toBeUndefined();
    expect(parsePayload(undefined)).toBeUndefined();
  });
});

describe("parseStringArray", () => {
  it("accepts JSON arrays, JSON strings and comma lists", () => {
    expect(parseStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStringArray('"a"')).toEqual(["a"]);
    expect(parseStringArray("a, b")).toEqual(["a", "b"]);
    expect(parseStringArray(undefined)).toEqual([]);
  });
});

describe("describeSpan", () => {
  it("renders DynamoDB with table, operation and item count", () => {
    const d = describeSpan(
      span({
        name: "DynamoDB.Query",
        attributes: aws("DynamoDB", "Query", {
          "aws.dynamodb.table_names": '["orders"]',
          "cloud.region": "eu-west-1",
          "ivy.payload.request": JSON.stringify({ TableName: "orders", IndexName: "byUser" }),
          "ivy.payload.response": JSON.stringify({ Count: 3, Items: [] }),
        }),
      }),
    );
    expect(d.icon).toBe("dynamodb");
    expect(d.operation).toBe("Query");
    expect(d.target).toBe("orders");
    expect(d.note).toBe("3 items returned");
    expect(d.fields).toContainEqual({ label: "Index", value: "byUser" });
    expect(d.fields).toContainEqual({ label: "Region", value: "eu-west-1" });
  });

  it("reports DynamoDB GetItem misses", () => {
    const d = describeSpan(
      span({
        attributes: aws("DynamoDB", "GetItem", {
          "aws.dynamodb.table_names": '["users"]',
          "ivy.payload.response": "{}",
        }),
      }),
    );
    expect(d.note).toBe("item not found");
  });

  it("falls back to TableName from the request payload", () => {
    const d = describeSpan(
      span({ attributes: aws("DynamoDB", "PutItem", { "ivy.payload.request": '{"TableName":"t1"}' }) }),
    );
    expect(d.target).toBe("t1");
  });

  it("renders S3 as an s3:// URI", () => {
    const d = describeSpan(
      span({
        attributes: aws("S3", "GetObject", {
          "aws.s3.bucket": "b",
          "aws.s3.key": "k/x.json",
          "ivy.payload.response": '{"ContentLength":2048}',
        }),
      }),
    );
    expect(d.icon).toBe("s3");
    expect(d.target).toBe("s3://b/k/x.json");
    expect(d.note).toBe("2,048 bytes");
    expect(d.graphLabel).toBe("b");
  });

  it("renders SQS queue and message id, deriving the queue from QueueUrl", () => {
    const withAttr = describeSpan(
      span({
        attributes: aws("SQS", "SendMessage", {
          "messaging.destination.name": "jobs",
          "messaging.message.id": "m-1",
        }),
      }),
    );
    expect(withAttr.icon).toBe("sqs");
    expect(withAttr.target).toBe("jobs");
    expect(withAttr.note).toBe("message m-1");

    const fromUrl = describeSpan(
      span({
        attributes: aws("SQS", "SendMessageBatch", {
          "ivy.payload.request": JSON.stringify({
            QueueUrl: "https://sqs.eu-west-1.amazonaws.com/1/jobs-dlq",
            Entries: [{}, {}],
          }),
        }),
      }),
    );
    expect(fromUrl.target).toBe("jobs-dlq");
    expect(fromUrl.note).toBe("2 messages");
  });

  it("renders SNS topic and subject", () => {
    const d = describeSpan(
      span({
        attributes: aws("SNS", "Publish", {
          "ivy.payload.request": JSON.stringify({
            TopicArn: "arn:aws:sns:eu-west-1:1:alerts",
            Subject: "Hi",
          }),
        }),
      }),
    );
    expect(d.icon).toBe("sns");
    expect(d.target).toBe("alerts");
    expect(d.note).toBe("“Hi”");
  });

  it("renders Lambda invokes", () => {
    const d = describeSpan(
      span({
        attributes: aws("Lambda", "Invoke", {
          "faas.invoked_name": "other-fn",
          "ivy.payload.request": '{"InvocationType":"Event"}',
        }),
      }),
    );
    expect(d.icon).toBe("lambda");
    expect(d.target).toBe("other-fn");
    expect(d.note).toBe("async");
  });

  it("renders EventBridge bus and detail types", () => {
    const d = describeSpan(
      span({
        attributes: aws("EventBridge", "PutEvents", {
          "aws.eventbridge.bus": "commerce",
          "aws.eventbridge.detail_types": '["OrderPaid","OrderShipped"]',
          "ivy.payload.response": '{"FailedEntryCount":1}',
        }),
      }),
    );
    expect(d.icon).toBe("eventBridge");
    expect(d.target).toBe("commerce");
    expect(d.note).toBe("OrderPaid, OrderShipped – 1 failed");
  });

  it("renders SES v1 and v2 recipients and subject", () => {
    const v2 = describeSpan(
      span({
        attributes: aws("SESv2", "SendEmail", {
          "ivy.payload.request": JSON.stringify({
            Destination: { ToAddresses: ["a@x.com"] },
            Content: { Simple: { Subject: { Data: "Welcome" } } },
          }),
        }),
      }),
    );
    expect(v2.icon).toBe("ses");
    expect(v2.target).toBe("a@x.com");
    expect(v2.note).toBe("“Welcome”");
    const v1 = describeSpan(
      span({
        attributes: aws("SES", "SendEmail", {
          "ivy.payload.request": JSON.stringify({ Message: { Subject: { Data: "Old" } } }),
        }),
      }),
    );
    expect(v1.note).toBe("“Old”");
  });

  it("uses a generic AWS icon for unknown services", () => {
    const d = describeSpan(span({ name: "Kinesis.PutRecord", attributes: aws("Kinesis", "PutRecord") }));
    expect(d.icon).toBe("aws");
    expect(d.serviceLabel).toBe("Kinesis");
    expect(d.operation).toBe("PutRecord");
  });

  it("renders HTTP calls and recognises known hosts", () => {
    const d = describeSpan(
      span({
        name: "POST api.stripe.com",
        attributes: {
          "http.request.method": "POST",
          "url.full": "https://api.stripe.com/v1/charges",
          "server.address": "api.stripe.com",
          "http.response.status_code": "402",
          "ivy.http.request.headers": '{"authorization":"[redacted]"}',
        },
      }),
    );
    expect(d.icon).toBe("external");
    expect(d.operation).toBe("POST");
    expect(d.target).toBe("https://api.stripe.com/v1/charges");
    expect(d.note).toBe("status 402");
    expect(d.requestHeaders).toEqual({ authorization: "[redacted]" });

    const slack = describeSpan(
      span({ attributes: { "http.request.method": "POST", "url.full": "https://hooks.slack.com/x" } }),
    );
    expect(slack.icon).toBe("slack");
  });

  it("groups repeated calls to the same resource", () => {
    const a = describeSpan(span({ attributes: aws("DynamoDB", "GetItem", { "aws.dynamodb.table_names": '["t"]' }) }));
    const b = describeSpan(span({ span_id: "s2", attributes: aws("DynamoDB", "GetItem", { "aws.dynamodb.table_names": '["t"]' }) }));
    const c = describeSpan(span({ attributes: aws("DynamoDB", "GetItem", { "aws.dynamodb.table_names": '["u"]' }) }));
    expect(a.groupingKey).toBe(b.groupingKey);
    expect(a.groupingKey).not.toBe(c.groupingKey);
  });

  it("describes the invocation span", () => {
    const d = describeSpan(
      span({
        name: "checkout",
        kind: "SERVER",
        parent_span_id: "",
        attributes: {
          "ivy.invocation": "true",
          "ivy.trigger.source": "aws:apigatewayv2",
          "http.request.method": "POST",
          "http.route": "/orders",
          "http.response.status_code": "201",
          "ivy.payload.request": '{"body":"{}"}',
        },
      }),
    );
    expect(d.isInvocation).toBe(true);
    expect(d.note).toBe("POST /orders – 201");
    expect(d.request).toEqual({ body: "{}" });
  });
});

describe("getException / getLogs", () => {
  it("extracts exceptions from events, falling back to span status", () => {
    const withEvent = span({
      status_code: "ERROR",
      events: [
        {
          ts: "t",
          name: "exception",
          attributes: { "exception.type": "TypeError", "exception.message": "boom", "exception.stacktrace": "at x" },
        },
      ],
    });
    expect(getException(withEvent)).toEqual({ type: "TypeError", message: "boom", stacktrace: "at x" });
    expect(
      getException(span({ status_code: "ERROR", status_message: "late", attributes: { "error.type": "Timeout" } })),
    ).toEqual({ type: "Timeout", message: "late" });
    expect(getException(span({}))).toBeUndefined();
  });

  it("collects log events across spans in time order", () => {
    const logs = getLogs([
      span({
        span_id: "a",
        events: [{ ts: "2026-01-01T00:00:02Z", name: "log", attributes: { "log.severity": "warn", "log.message": "b" } }],
      }),
      span({
        span_id: "b",
        events: [
          { ts: "2026-01-01T00:00:01Z", name: "log", attributes: { "log.message": "a" } },
          { ts: "2026-01-01T00:00:03Z", name: "exception", attributes: {} },
        ],
      }),
    ]);
    expect(logs.map((l) => [l.message, l.severity, l.spanId])).toEqual([
      ["a", "info", "b"],
      ["b", "warn", "a"],
    ]);
  });
});
