import type { ErrorGroup, Invocation, Span, SpanEvent, Trace } from "@ivy/spans";
import * as AI from "./ai-traces.js";

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

function supportInvocation(id: string, duration: number, response: string): SpanSpec {
  return {
    id,
    name: "support-answerTicket",
    kind: "SERVER",
    offset: 0,
    duration,
    status: "OK",
    attributes: {
      "ivy.invocation": "true",
      "faas.invocation_id": "5a7e1c90-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "faas.coldstart": "false",
      "faas.trigger": "http",
      "ivy.trigger.source": "aws:apigatewayv2",
      "cloud.resource_id": "arn:aws:lambda:eu-west-1:123456789012:function:support-answerTicket",
      "http.request.method": "POST",
      "url.path": "/support/messages",
      "http.route": "/support/messages",
      "http.response.status_code": "200",
      "ivy.memory_used_mb": "142",
      "ivy.payload.request": JSON.stringify({
        routeKey: "POST /support/messages",
        headers: { "content-type": "application/json", authorization: "[redacted]" },
        body: JSON.stringify({ customerId: "cus_ada", message: AI.QUESTION }),
      }),
      "ivy.payload.response": JSON.stringify({ statusCode: 200, body: JSON.stringify({ reply: response }) }),
    },
    events: [log(3, "info", "Answering ticket for cus_ada")],
  };
}

const llmHttp = (host: string, path: string, status = 200) => ({
  "http.request.method": "POST",
  "url.full": `https://${host}${path}`,
  "server.address": host,
  "server.port": "443",
  "http.response.status_code": String(status),
});

const orderLookup = (id: string, parent: string, offset: number): SpanSpec => ({
  id,
  parent,
  name: "DynamoDB.GetItem",
  offset,
  duration: 17.6,
  status: "OK",
  attributes: aws(
    "DynamoDB",
    "GetItem",
    { "aws.dynamodb.table_names": '["orders-prod"]' },
    { TableName: "orders-prod", Key: { pk: { S: "ORDER#ord_8812" } } },
    { Item: { pk: { S: "ORDER#ord_8812" }, status: { S: "shipped" }, carrier: { S: "DHL" } } },
  ),
});

/** API Gateway → Lambda support bot on the Vercel AI SDK 6 (`ai.*` spans): generateText with a tool call, then streamText. */
export const supportBot = build(traceIdAt(20_000, "a1b2c3d4e5f6a7b8c9d0e1f2"), 20_000, "eu-west-1", "support-answerTicket", [
  supportInvocation("e1", 2140.6, AI.REPLY),
  { id: "e2", parent: "e1", name: "ai.generateText", kind: "INTERNAL", offset: 9, duration: 1630.2, status: "UNSET", attributes: AI.aiSdkAttributes.generateText },
  { id: "e3", parent: "e2", name: "ai.generateText.doGenerate", kind: "INTERNAL", offset: 11, duration: 611.4, attributes: AI.aiSdkAttributes.doGenerate(1) },
  { id: "e4", parent: "e3", name: "POST api.openai.com", offset: 13, duration: 606.8, attributes: llmHttp("api.openai.com", "/v1/chat/completions") },
  { id: "e5", parent: "e2", name: "ai.toolCall", kind: "INTERNAL", offset: 625, duration: 21.3, attributes: AI.aiSdkAttributes.toolCall },
  orderLookup("e6", "e5", 627),
  { id: "e7", parent: "e2", name: "ai.generateText.doGenerate", kind: "INTERNAL", offset: 650, duration: 987.5, attributes: AI.aiSdkAttributes.doGenerate(2) },
  { id: "e8", parent: "e7", name: "POST api.openai.com", offset: 652, duration: 983.1, attributes: llmHttp("api.openai.com", "/v1/chat/completions") },
  { id: "e9", parent: "e1", name: "ai.streamText", kind: "INTERNAL", offset: 1645, duration: 488.9, attributes: AI.aiSdkAttributes.streamText },
  {
    id: "ea",
    parent: "e9",
    name: "ai.streamText.doStream",
    kind: "INTERNAL",
    offset: 1647,
    duration: 485.2,
    attributes: AI.aiSdkAttributes.doStream(318.4),
    events: [
      { offset: 1965, name: "ai.stream.firstChunk", attributes: { "ai.response.msToFirstChunk": "318.4" } },
      { offset: 2131, name: "ai.stream.finish", attributes: {} },
    ],
  },
  { id: "eb", parent: "ea", name: "POST api.anthropic.com", offset: 1649, duration: 482.7, attributes: llmHttp("api.anthropic.com", "/v1/messages") },
]);

/** The same flow on AI SDK 7's GenAI semantic-convention spans (`invoke_agent`, `step n`, `chat`, `execute_tool`). */
export const supportBotGenAi = build(traceIdAt(25_000, "f1e2d3c4b5a6978877665544"), 25_000, "eu-west-1", "support-answerTicket", [
  supportInvocation("g1", 1652.4, AI.ANSWER),
  { id: "g2", parent: "g1", name: "invoke_agent gpt-4o-mini", kind: "INTERNAL", offset: 9, duration: 1630.2, attributes: AI.genAiAttributes.agent },
  { id: "g3", parent: "g2", name: "step 1", kind: "INTERNAL", offset: 10, duration: 638.1, attributes: AI.genAiAttributes.step },
  { id: "g4", parent: "g3", name: "chat gpt-4o-mini", offset: 11, duration: 611.4, attributes: AI.genAiAttributes.chat(1) },
  { id: "g5", parent: "g3", name: "execute_tool getOrder", kind: "INTERNAL", offset: 625, duration: 21.3, attributes: AI.genAiAttributes.tool },
  orderLookup("g6", "g5", 627),
  { id: "g7", parent: "g2", name: "step 2", kind: "INTERNAL", offset: 649, duration: 989.0, attributes: AI.genAiAttributes.step },
  { id: "g8", parent: "g7", name: "chat gpt-4o-mini", offset: 650, duration: 987.5, attributes: AI.genAiAttributes.chat(2) },
]);

export const traces = [checkoutFailed, checkoutOk, queueFailed, plainOtel, supportBot, supportBotGenAi];
