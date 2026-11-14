import type { ErrorGroup, Invocation, Span, SpanEvent, Trace } from "@ivy/spans";

/**
 * Realistic traces in the `GET /api/traces/:id` shape, modelled on the UI's mock fixtures and the
 * loadgen scenarios, with fixed timestamps so snapshots are stable.
 */

const BASE = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (offset: number) => new Date(BASE + offset).toISOString();
const traceIdAt = (offset: number, suffix: string) => Math.floor((BASE + offset) / 1000).toString(16) + suffix.padStart(24, "0");

interface SpanSpec {
  id: string;
  parent?: string;
  name: string;
  kind?: Span["kind"];
  offset: number;
  duration: number;
  attributes?: Record<string, string>;
  status?: Span["status_code"];
  statusMessage?: string;
  events?: { offset: number; name: string; attributes: Record<string, string> }[];
}

function build(traceId: string, start: number, region: string, service: string, specs: SpanSpec[]): Trace {
  return {
    trace_id: traceId,
    spans: specs.map((s) => ({
      span_id: s.id.padStart(16, "0"),
      parent_span_id: s.parent ? s.parent.padStart(16, "0") : "",
      name: s.name,
      kind: s.kind ?? "CLIENT",
      service,
      start: iso(start + s.offset),
      end: iso(start + s.offset + s.duration),
      duration_ms: s.duration,
      status_code: s.status ?? "UNSET",
      status_message: s.statusMessage ?? "",
      attributes: s.attributes ?? {},
      resource: { "service.name": service, "cloud.region": region, "cloud.provider": "aws" },
      events: (s.events ?? []).map(
        (e): SpanEvent => ({ ts: iso(start + e.offset), name: e.name, attributes: e.attributes }),
      ),
    })),
  };
}

const aws = (service: string, method: string, extra: Record<string, string>, request: unknown, response: unknown, status = "200") => ({
  "rpc.system": "aws-api",
  "rpc.service": service,
  "rpc.method": method,
  "cloud.region": "eu-west-1",
  "aws.request_id": `${service.toUpperCase()}${method.toUpperCase()}REQ`,
  "http.response.status_code": status,
  ...extra,
  "ivy.payload.request": JSON.stringify(request),
  "ivy.payload.response": JSON.stringify(response),
});

const http = (method: string, url: string, status: number, request: unknown, response: unknown) => ({
  "http.request.method": method,
  "url.full": url,
  "server.address": new URL(url).hostname,
  "server.port": "443",
  "http.response.status_code": String(status),
  "ivy.payload.request": request === undefined ? "" : JSON.stringify(request),
  "ivy.payload.response": JSON.stringify(response),
  "ivy.http.request.headers": JSON.stringify({ "content-type": "application/json", authorization: "[redacted]" }),
  "ivy.http.response.headers": JSON.stringify({ "content-type": "application/json", "request-id": "req_8Hk2" }),
});

const log = (offset: number, severity: string, message: string) => ({
  offset,
  name: "log",
  attributes: { "log.severity": severity, "log.message": message },
});

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at createPaymentIntent (/var/task/src/payments.js:42:31)",
  "    at async createOrder (/var/task/src/handler.js:88:21)",
  "    at async Runtime.handler (/var/task/node_modules/@ivy/layer/wrap.js:120:14)",
  "    at async processTicksAndRejections (node:internal/process/task_queues:95:5)",
  "    at async /var/runtime/index.mjs:1188:29",
].join("\n");

function checkoutSpans(failed: boolean, orderId: string): SpanSpec[] {
  const invocation: SpanSpec = {
    id: "a1",
    name: "checkout-createOrder",
    kind: "SERVER",
    offset: 0,
    duration: failed ? 212.4 : 268.9,
    status: failed ? "ERROR" : "OK",
    statusMessage: failed ? "Cannot read properties of undefined (reading 'id')" : "",
    attributes: {
      "ivy.invocation": "true",
      "faas.invocation_id": failed ? "8f1c2d3e-0a1b-4c5d-8e9f-a0b1c2d3e4f5" : "1b2c3d4e-5f60-4718-a9b0-c1d2e3f4a5b6",
      "faas.coldstart": failed ? "true" : "false",
      "faas.trigger": "http",
      "ivy.trigger.source": "aws:apigatewayv2",
      "cloud.resource_id": "arn:aws:lambda:eu-west-1:123456789012:function:checkout-createOrder",
      "http.request.method": "POST",
      "url.path": "/orders",
      "http.route": "/orders",
      "http.response.status_code": failed ? "500" : "201",
      "ivy.memory_used_mb": failed ? "96" : "88",
      ...(failed ? { "error.type": "TypeError" } : {}),
      "ivy.payload.request": JSON.stringify({
        routeKey: "POST /orders",
        headers: { "content-type": "application/json", authorization: "[redacted]" },
        body: JSON.stringify({ cartId: "cart_u_8812", paymentMethod: failed ? "pm_card_declined" : "pm_card_visa" }),
      }),
      "ivy.payload.response": failed
        ? JSON.stringify({ statusCode: 500, body: '{"message":"Internal Server Error"}' })
        : JSON.stringify({ statusCode: 201, body: JSON.stringify({ orderId }) }),
    },
    events: [
      log(2, "info", `Creating order for cart cart_u_8812`),
      ...(failed
        ? [
            log(171, "warn", "Stripe returned 402 card_declined for customer cus_Q1w2e3"),
            log(205, "error", "Order failed: TypeError: Cannot read properties of undefined (reading 'id')"),
            {
              offset: 210,
              name: "exception",
              attributes: {
                "exception.type": "TypeError",
                "exception.message": "Cannot read properties of undefined (reading 'id')",
                "exception.stacktrace": STACK,
              },
            },
          ]
        : [log(262, "info", `Order ${orderId} created`)]),
    ],
  };
  const common: SpanSpec[] = [
    {
      id: "b1",
      parent: "a1",
      name: "DynamoDB.GetItem",
      offset: 4,
      duration: failed ? 11.6 : 9.8,
      attributes: aws(
        "DynamoDB",
        "GetItem",
        { "aws.dynamodb.table_names": JSON.stringify(["checkout-users"]) },
        { TableName: "checkout-users", Key: { pk: { S: "USER#u_8812" } } },
        { Item: { pk: { S: "USER#u_8812" }, email: { S: "ada@example.com" }, stripeCustomerId: { S: "cus_Q1w2e3" } } },
      ),
    },
    {
      id: "b2",
      parent: "a1",
      name: "DynamoDB.Query",
      offset: 17,
      duration: failed ? 15.2 : 21.4,
      attributes: aws(
        "DynamoDB",
        "Query",
        { "aws.dynamodb.table_names": JSON.stringify(["checkout-carts"]) },
        { TableName: "checkout-carts", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "CART#u_8812" } } },
        { Count: 3, ScannedCount: 3, Items: [{ sku: { S: "SKU-1" } }, { sku: { S: "SKU-7" } }, { sku: { S: "SKU-9" } }] },
      ),
    },
    {
      id: "b3",
      parent: "a1",
      name: "POST api.stripe.com",
      offset: 36,
      duration: failed ? 134.7 : 141.3,
      attributes: http(
        "POST",
        "https://api.stripe.com/v1/payment_intents",
        failed ? 402 : 200,
        { amount: 4999, currency: "eur", customer: "cus_Q1w2e3", payment_method: failed ? "pm_card_declined" : "pm_card_visa" },
        failed
          ? { error: { code: "card_declined", decline_code: "insufficient_funds", message: "Your card was declined.", type: "card_error" } }
          : { id: "pi_3Nk2Lm", object: "payment_intent", status: "succeeded", amount: 4999, currency: "eur" },
      ),
    },
  ];
  if (failed) return [invocation, ...common];
  return [
    invocation,
    ...common,
    {
      id: "b4",
      parent: "a1",
      name: "DynamoDB.PutItem",
      offset: 181,
      duration: 13.1,
      attributes: aws(
        "DynamoDB",
        "PutItem",
        { "aws.dynamodb.table_names": JSON.stringify(["checkout-orders"]) },
        { TableName: "checkout-orders", Item: { pk: { S: `ORDER#${orderId}` }, total: { N: "4999" } }, ConditionExpression: "attribute_not_exists(pk)" },
        {},
      ),
    },
    {
      id: "b5",
      parent: "a1",
      name: "S3.PutObject",
      offset: 196,
      duration: 38.2,
      attributes: aws(
        "S3",
        "PutObject",
        { "aws.s3.bucket": "checkout-receipts-prod", "aws.s3.key": `receipts/${orderId}.pdf` },
        { Bucket: "checkout-receipts-prod", Key: `receipts/${orderId}.pdf`, ContentType: "application/pdf", Body: "[binary 18233 bytes]" },
        { ETag: '"9b2cf535f27731c974343645a3985328"' },
      ),
    },
    {
      id: "b6",
      parent: "a1",
      name: "SQS.SendMessage",
      offset: 236,
      duration: 16.4,
      attributes: aws(
        "SQS",
        "SendMessage",
        { "messaging.system": "aws_sqs", "messaging.destination.name": "order-events", "messaging.message.id": "5fea7756-0ea4-451a-a703-a558b933e274" },
        { QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/order-events", MessageBody: JSON.stringify({ type: "order.created", orderId }) },
        { MessageId: "5fea7756-0ea4-451a-a703-a558b933e274" },
      ),
    },
  ];
}

export const checkoutFailed = build(traceIdAt(0, "9a1b2c3d4e5f60718293a4b5"), 0, "eu-west-1", "checkout-createOrder", checkoutSpans(true, "ord_7Hq2x9Kd01"));

export const checkoutOk = build(
  traceIdAt(-90_000, "1c2d3e4f5a6b7c8d9e0f1a2b"),
  -90_000,
  "eu-west-1",
  "checkout-createOrder",
  checkoutSpans(false, "ord_3Lm8p2Zq77"),
);

/** SQS consumer: a batch of lookups (collapsed), a failed conditional update, a payload cut at the source. */
export const queueFailed = build(traceIdAt(5_000, "77aa88bb99cc00dd11ee22ff"), 5_000, "eu-west-1", "orders-processQueue", [
  {
    id: "c1",
    name: "orders-processQueue",
    kind: "CONSUMER",
    offset: 0,
    duration: 96.3,
    status: "ERROR",
    statusMessage: "ConditionalCheckFailedException: The conditional request failed",
    attributes: {
      "ivy.invocation": "true",
      "faas.invocation_id": "c0ffee00-1111-4222-8333-444455556666",
      "faas.coldstart": "false",
      "faas.trigger": "pubsub",
      "ivy.trigger.source": "aws:sqs",
      "error.type": "ConditionalCheckFailedException",
      "ivy.memory_used_mb": "71",
      "ivy.payload.truncated": "true",
      "ivy.payload.request": `${JSON.stringify({
        Records: Array.from({ length: 8 }, (_, i) => ({
          messageId: `m-${i}`,
          body: JSON.stringify({ type: "order.created", orderId: `ord_${i}`, customer: { email: "ada@example.com", apiKey: "[redacted]" } }),
          eventSource: "aws:sqs",
        })),
      }).slice(0, 700)}…[truncated 2214 bytes]`,
    },
    events: [
      log(1, "info", "Processing 8 records"),
      log(80, "warn", "Order ord_7 is not pending (status=paid); skipping is not allowed for this event type"),
      {
        offset: 95,
        name: "exception",
        attributes: {
          "exception.type": "ConditionalCheckFailedException",
          "exception.message": "The conditional request failed",
          "exception.stacktrace": [
            "ConditionalCheckFailedException: The conditional request failed",
            "    at throwDefaultError (/var/task/node_modules/@smithy/smithy-client/dist-cjs/index.js:867:20)",
            "    at de_UpdateItemCommand (/var/task/node_modules/@aws-sdk/client-dynamodb/dist-cjs/index.js:2241:21)",
            "    at async markPaid (/var/task/src/orders.js:31:5)",
            "    at async processRecord (/var/task/src/queue.js:19:3)",
          ].join("\n"),
        },
      },
    ],
  },
  ...Array.from(
    { length: 8 },
    (_, i): SpanSpec => ({
      id: `d${i}`,
      parent: "c1",
      name: "DynamoDB.GetItem",
      offset: 3 + i * 9,
      duration: 6.2 + i * 0.7,
      attributes: aws(
        "DynamoDB",
        "GetItem",
        { "aws.dynamodb.table_names": JSON.stringify(["checkout-orders"]) },
        { TableName: "checkout-orders", Key: { pk: { S: `ORDER#ord_${i}` } } },
        { Item: { pk: { S: `ORDER#ord_${i}` }, status: { S: i === 7 ? "paid" : "pending" } } },
      ),
    }),
  ),
  {
    id: "e1",
    parent: "c1",
    name: "DynamoDB.UpdateItem",
    offset: 82,
    duration: 12.9,
    status: "ERROR",
    statusMessage: "ConditionalCheckFailedException: The conditional request failed",
    attributes: aws(
      "DynamoDB",
      "UpdateItem",
      { "aws.dynamodb.table_names": JSON.stringify(["checkout-orders"]) },
      {
        TableName: "checkout-orders",
        Key: { pk: { S: "ORDER#ord_7" } },
        UpdateExpression: "SET #s = :s",
        ConditionExpression: "#s = :pending",
      },
      { __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "The conditional request failed" },
      "400",
    ),
  },
]);

/** A trace from a plain OpenTelemetry producer (no Ivy invocation marker). */
export const plainOtel = build(traceIdAt(9_000, "0102030405060708090a0b0c"), 9_000, "eu-west-1", "inventory-service", [
  { id: "f1", name: "GET /inventory/:sku", kind: "SERVER", offset: 0, duration: 42.5, status: "OK" },
  { id: "f2", parent: "f1", name: "load-stock", kind: "INTERNAL", offset: 2, duration: 30.1 },
  {
    id: "f3",
    parent: "f2",
    name: "GET warehouse.internal",
    offset: 4,
    duration: 25.3,
    attributes: { "http.request.method": "GET", "url.full": "https://warehouse.internal/v2/stock/SKU-7", "http.response.status_code": "200" },
  },
]);

export const invocations: Invocation[] = [
  {
    trace_id: checkoutFailed.trace_id,
    span_id: "00000000000000a1",
    ts: "2026-11-14T12:00:00.000Z",
    function: "checkout-createOrder",
    region: "eu-west-1",
    status: "error",
    duration_ms: 212.4,
    cold_start: true,
    request_id: "8f1c2d3e-0a1b-4c5d-8e9f-a0b1c2d3e4f5",
    trigger: "aws:apigatewayv2",
    http_method: "POST",
    http_path: "/orders",
    http_status: 500,
    error_type: "TypeError",
    error_message: "Cannot read properties of undefined (reading 'id')",
    memory_used_mb: 96,
  },
  {
    trace_id: queueFailed.trace_id,
    span_id: "00000000000000c1",
    ts: "2026-11-14T12:00:05.000Z",
    function: "orders-processQueue",
    region: "eu-west-1",
    status: "error",
    duration_ms: 96.3,
    cold_start: false,
    request_id: "c0ffee00-1111-4222-8333-444455556666",
    trigger: "aws:sqs",
    http_method: null,
    http_path: null,
    http_status: null,
    error_type: "ConditionalCheckFailedException",
    error_message: "The conditional request failed",
    memory_used_mb: 71,
  },
  {
    trace_id: checkoutOk.trace_id,
    span_id: "00000000000000a1",
    ts: "2026-11-14T11:58:30.000Z",
    function: "checkout-createOrder",
    region: "eu-west-1",
    status: "ok",
    duration_ms: 268.9,
    cold_start: false,
    request_id: "1b2c3d4e-5f60-4718-a9b0-c1d2e3f4a5b6",
    trigger: "aws:apigatewayv2",
    http_method: "POST",
    http_path: "/orders",
    http_status: 201,
    error_type: null,
    error_message: null,
    memory_used_mb: 88,
  },
];

export const errorGroups: ErrorGroup[] = [
  {
    fingerprint: "f1a2",
    function: "checkout-createOrder",
    error_type: "TypeError",
    error_message: "Cannot read properties of undefined (reading 'id')",
    count: 42,
    first_seen: "2026-11-14T08:12:44.120Z",
    last_seen: "2026-11-14T12:00:00.000Z",
    sample_trace_id: checkoutFailed.trace_id,
  },
  {
    fingerprint: "b3c4",
    function: "orders-processQueue",
    error_type: "ConditionalCheckFailedException",
    error_message: "The conditional request failed",
    count: 7,
    first_seen: "2026-11-14T10:01:02.000Z",
    last_seen: "2026-11-14T12:00:05.000Z",
    sample_trace_id: queueFailed.trace_id,
  },
];

export const traces = [checkoutFailed, checkoutOk, queueFailed, plainOtel];
