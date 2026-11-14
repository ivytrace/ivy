import type { FailureKind } from "@ivy/spans";
import type { Invocation, Span, SpanEvent } from "../api/types.ts";
import {
  RATE_LIMIT,
  SUPPORT_TIMELINE_MS,
  supportEvent,
  supportResponse,
  supportSpans,
  TRIAGE_TIMELINE_MS,
  triageEvent,
  triageSpans,
  type AiSpanSpec,
} from "./ai.ts";
import { IMPORT_FUNCTION, IMPORT_TIMELINE_MS, IMPORT_TRACE_ID, importLogs, importRootAttributes, importSpans } from "./import.ts";

const SUPPORT_FUNCTION = "support-answerTicket";
/** Calls Amazon Bedrock directly with the AWS SDK. */
const TRIAGE_FUNCTION = "support-triageTicket";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const hex = (rand: () => number, n: number) =>
  Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

const iso = (ms: number) => new Date(ms).toISOString();

interface FunctionDef {
  name: string;
  region: string;
  trigger: string;
  kind: "SERVER" | "CONSUMER" | "INTERNAL";
  http?: { method: string; path: string; route: string };
  weight: number;
  errorRate: number;
}

export const FUNCTIONS: FunctionDef[] = [
  {
    name: "checkout-createOrder",
    region: "eu-west-1",
    trigger: "aws:apigatewayv2",
    kind: "SERVER",
    http: { method: "POST", path: "/orders", route: "/orders" },
    weight: 5,
    errorRate: 0.08,
  },
  {
    name: "orders-processQueue",
    region: "eu-west-1",
    trigger: "aws:sqs",
    kind: "CONSUMER",
    weight: 4,
    errorRate: 0.03,
  },
  {
    name: "auth-getProfile",
    region: "eu-central-1",
    trigger: "aws:apigateway",
    kind: "SERVER",
    http: { method: "GET", path: "/me", route: "/me" },
    weight: 6,
    errorRate: 0.02,
  },
  {
    name: "email-sendReceipt",
    region: "eu-west-1",
    trigger: "aws:sqs",
    kind: "CONSUMER",
    weight: 1,
    errorRate: 0.01,
  },
  {
    name: "reports-nightlyExport",
    region: "us-east-1",
    trigger: "aws:scheduled",
    kind: "INTERNAL",
    weight: 1,
    errorRate: 0.3,
  },
  {
    name: SUPPORT_FUNCTION,
    region: "eu-west-1",
    trigger: "aws:apigatewayv2",
    kind: "SERVER",
    http: { method: "POST", path: "/support/messages", route: "/support/messages" },
    weight: 2,
    errorRate: 0.06,
  },
  {
    name: TRIAGE_FUNCTION,
    region: "eu-west-1",
    trigger: "aws:sqs",
    kind: "CONSUMER",
    weight: 1,
    errorRate: 0,
  },
  // Not picked at random: importInvocations() runs it every three hours.
  {
    name: IMPORT_FUNCTION,
    region: "eu-west-1",
    trigger: "aws:s3",
    kind: "CONSUMER",
    weight: 0,
    errorRate: 0,
  },
];

const supportTimeline = (failed: boolean) => (failed ? 880 : SUPPORT_TIMELINE_MS);

export interface MockInvocation extends Invocation {
  seed: number;
}

export const NOW = Date.now();
const WEEK = 7 * 24 * 3600 * 1000;
/** email-sendReceipt was deployed with a missing dependency this long ago: every invocation since fails at init. */
const BROKEN_DEPLOY_MS = 40 * 60_000;
const MEMORY_MB = 256;

function buildInvocations(): MockInvocation[] {
  const rand = rng(42);
  const totalWeight = FUNCTIONS.reduce((a, f) => a + f.weight, 0);
  const out: MockInvocation[] = [];
  let t = NOW - 20_000;
  while (t > NOW - WEEK) {
    let pick = rand() * totalWeight;
    const fn = FUNCTIONS.find((f) => (pick -= f.weight) < 0) ?? FUNCTIONS[0];
    const seed = Math.floor(rand() * 2 ** 31);
    const r = rng(seed);
    const initBroken = fn.name === "email-sendReceipt" && NOW - t < BROKEN_DEPLOY_MS;
    const isError = initBroken || r() < fn.errorRate;
    const coldStart = initBroken || r() < 0.06;
    const error = initBroken ? INIT_ERROR : isError ? errorFor(fn, r) : null;
    const initMs = coldStart ? Math.round((180 + r() * 240) * 10) / 10 : null;
    const base = 40 + r() * 250 + (coldStart ? 400 : 0) + (isError ? 120 : 0) + (error?.kind === "out_of_memory" ? 2200 : 0);
    // LLM calls take seconds: the support bot's spans are laid out on a fixed timeline, stretched a little.
    const duration = initBroken
      ? (initMs ?? 200)
      : error?.kind === "timed_out"
        ? 30_000
        : Math.round(
            (fn.name === SUPPORT_FUNCTION
              ? supportTimeline(isError) * (0.85 + base / 1000)
              : fn.name === TRIAGE_FUNCTION
                ? TRIAGE_TIMELINE_MS * (0.85 + base / 1000)
                : base) * 10,
          ) / 10;
    const traceId = Math.floor(t / 1000).toString(16).padStart(8, "0") + hex(r, 24);
    // At init Lambda may have no request yet; a retried invoke gives the extension one.
    const requestId = initBroken && r() < 0.3 ? "" : `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
    out.push({
      seed,
      trace_id: traceId,
      span_id: hex(r, 16),
      ts: iso(t),
      function: fn.name,
      region: fn.region,
      status: isError ? "error" : "ok",
      duration_ms: duration,
      cold_start: coldStart,
      request_id: requestId,
      trigger: fn.trigger,
      http_method: fn.http?.method ?? null,
      http_path: fn.http?.path ?? null,
      http_status: fn.http ? (isError ? 500 : 200) : null,
      error_type: error?.type ?? null,
      error_message: error?.message ?? null,
      memory_used_mb: initBroken ? null : error?.kind === "out_of_memory" ? MEMORY_MB : Math.round(70 + r() * 60),
      memory_limit_mb: MEMORY_MB,
      failure_phase: error?.kind === "init_failed" ? "init" : error?.kind ? "invoke" : null,
      failure_kind: error?.kind ?? null,
      synthetic: initBroken,
      init_duration_ms: initMs,
    });
    const recent = NOW - t < 3600_000;
    t -= Math.floor((recent ? 15_000 : 240_000) * (0.3 + rand()));
  }
  return out;
}

interface MockError {
  type: string;
  message: string;
  kind?: FailureKind;
}

const INIT_ERROR: MockError = { type: "Runtime.ImportModuleError", message: "Error: Cannot find module 'mjml'", kind: "init_failed" };

function errorFor(fn: FunctionDef, r: () => number): MockError {
  switch (fn.name) {
    case "checkout-createOrder":
      return { type: "TypeError", message: "Cannot read properties of undefined (reading 'id')" };
    case "orders-processQueue":
      return {
        type: "ConditionalCheckFailedException",
        message: "The conditional request failed",
      };
    case "reports-nightlyExport":
      return r() < 0.5
        ? { type: "Sandbox.Timedout", message: "Task timed out after 30.00 seconds", kind: "timed_out" }
        : {
            type: "Runtime.OutOfMemory",
            message: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
            kind: "out_of_memory",
          };
    case "email-sendReceipt":
      return {
        type: "SESv2.MessageRejected",
        message: `Email address is not verified. The following identities failed the check in region EU-WEST-1: ${pick(RECIPIENTS, r)}`,
      };
    case SUPPORT_FUNCTION:
      return RATE_LIMIT;
    default:
      return r() < 0.5
        ? { type: "UnauthorizedError", message: "jwt expired" }
        : { type: "Error", message: `Upload not found for ID: ${pick(UPLOADS, r)}` };
  }
}

const RECIPIENTS = ["bob@example.com", "carol@example.com", "dave@example.org"];
const UPLOADS = [
  "fonts/mono-regular.woff",
  "favicon.ico",
  "_code-highlighting.js",
  "fonts/semibold.woff2",
  "_mermaid.js",
  "avatars/3f1c9a2e.png",
  "fonts/mono-bold.woff2",
];
const pick = <T,>(list: T[], r: () => number) => list[Math.floor(r() * list.length)];

/** The import worker, every three hours; the most recent one has a fixed trace ID (`IMPORT_TRACE_ID`). */
function importInvocations(): MockInvocation[] {
  const rand = rng(7);
  const out: MockInvocation[] = [];
  for (let t = NOW - 4 * 60_000; t > NOW - WEEK; t -= 3 * 3600_000) {
    const seed = Math.floor(rand() * 2 ** 31);
    const r = rng(seed);
    out.push({
      seed,
      trace_id: out.length ? Math.floor(t / 1000).toString(16).padStart(8, "0") + hex(r, 24) : IMPORT_TRACE_ID,
      span_id: hex(r, 16),
      ts: iso(t),
      function: IMPORT_FUNCTION,
      region: "eu-west-1",
      status: "ok",
      duration_ms: Math.round(IMPORT_TIMELINE_MS * (0.92 + r() * 0.16) * 10) / 10,
      cold_start: false,
      request_id: `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`,
      trigger: "aws:s3",
      http_method: null,
      http_path: null,
      http_status: null,
      error_type: null,
      error_message: null,
      memory_used_mb: Math.round(170 + r() * 30),
      memory_limit_mb: MEMORY_MB,
      failure_phase: null,
      failure_kind: null,
      synthetic: false,
      init_duration_ms: null,
    });
  }
  return out;
}

export const INVOCATIONS = [...buildInvocations(), ...importInvocations()].sort((a, b) => b.ts.localeCompare(a.ts));

interface SpanSpec {
  name: string;
  kind?: Span["kind"];
  offset: number;
  duration: number;
  attributes: Record<string, string>;
  status?: Span["status_code"];
  statusMessage?: string;
  events?: SpanEvent[];
  children?: SpanSpec[];
}

const aws = (
  service: string,
  method: string,
  extra: Record<string, string>,
  request: unknown,
  response: unknown,
  region = "eu-west-1",
): Record<string, string> => ({
  "rpc.system": "aws-api",
  "rpc.service": service,
  "rpc.method": method,
  "cloud.region": region,
  "aws.request_id": "R" + Math.abs(hash(service + method)).toString(36).toUpperCase().padEnd(12, "Q"),
  "http.response.status_code": "200",
  ...extra,
  "ivy.payload.request": JSON.stringify(request),
  "ivy.payload.response": JSON.stringify(response),
});

const http = (
  method: string,
  url: string,
  status: number,
  request: unknown,
  response: unknown,
): Record<string, string> => {
  const u = new URL(url);
  return {
    "http.request.method": method,
    "url.full": url,
    "server.address": u.hostname,
    "server.port": "443",
    "http.response.status_code": String(status),
    "ivy.payload.request": request === undefined ? "" : JSON.stringify(request),
    "ivy.payload.response": JSON.stringify(response),
    "ivy.http.request.headers": JSON.stringify({
      "content-type": "application/json",
      authorization: "[redacted]",
      "user-agent": "node",
    }),
    "ivy.http.response.headers": JSON.stringify({
      "content-type": "application/json",
      "request-id": "req_" + hash(url).toString(36),
    }),
  };
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function childrenFor(inv: MockInvocation, r: () => number): SpanSpec[] {
  const failed = inv.status === "error";
  const orderId = `ord_${hex(r, 10)}`;
  switch (inv.function) {
    case "checkout-createOrder":
      return [
        {
          name: "DynamoDB.GetItem",
          offset: 4,
          duration: 9 + r() * 10,
          attributes: aws(
            "DynamoDB",
            "GetItem",
            { "aws.dynamodb.table_names": JSON.stringify(["checkout-users"]) },
            { TableName: "checkout-users", Key: { pk: { S: "USER#u_8812" } } },
            {
              Item: {
                pk: { S: "USER#u_8812" },
                email: { S: "ada@example.com" },
                stripeCustomerId: { S: "cus_Q1w2e3" },
              },
            },
          ),
        },
        {
          name: "DynamoDB.Query",
          offset: 16,
          duration: 14 + r() * 12,
          attributes: aws(
            "DynamoDB",
            "Query",
            { "aws.dynamodb.table_names": JSON.stringify(["checkout-carts"]) },
            {
              TableName: "checkout-carts",
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: { ":pk": { S: "CART#u_8812" } },
            },
            {
              Count: 3,
              ScannedCount: 3,
              Items: [
                { sku: { S: "SKU-1" }, qty: { N: "1" } },
                { sku: { S: "SKU-7" }, qty: { N: "2" } },
                { sku: { S: "SKU-9" }, qty: { N: "1" } },
              ],
            },
          ),
        },
        {
          name: "POST api.stripe.com",
          offset: 34,
          duration: 120 + r() * 80,
          attributes: http(
            "POST",
            "https://api.stripe.com/v1/payment_intents",
            failed ? 402 : 200,
            { amount: 4999, currency: "eur", customer: "cus_Q1w2e3" },
            failed
              ? { error: { code: "card_declined", message: "Your card was declined." } }
              : { id: "pi_3Nk2", status: "succeeded", amount: 4999 },
          ),
        },
        ...(failed
          ? []
          : [
              {
                name: "DynamoDB.PutItem",
                offset: 180,
                duration: 11 + r() * 8,
                attributes: aws(
                  "DynamoDB",
                  "PutItem",
                  { "aws.dynamodb.table_names": JSON.stringify(["checkout-orders"]) },
                  {
                    TableName: "checkout-orders",
                    Item: { pk: { S: `ORDER#${orderId}` }, total: { N: "4999" } },
                    ConditionExpression: "attribute_not_exists(pk)",
                  },
                  {},
                ),
              },
              {
                name: "S3.PutObject",
                offset: 195,
                duration: 30 + r() * 25,
                attributes: aws(
                  "S3",
                  "PutObject",
                  { "aws.s3.bucket": "checkout-receipts-prod", "aws.s3.key": `receipts/${orderId}.pdf` },
                  {
                    Bucket: "checkout-receipts-prod",
                    Key: `receipts/${orderId}.pdf`,
                    ContentType: "application/pdf",
                    Body: "[binary 18233 bytes]",
                  },
                  { ETag: '"9b2cf535f27731c974343645a3985328"', VersionId: "null" },
                ),
              },
              {
                name: "SQS.SendMessage",
                offset: 230,
                duration: 12 + r() * 10,
                attributes: aws(
                  "SQS",
                  "SendMessage",
                  {
                    "messaging.system": "aws_sqs",
                    "messaging.destination.name": "order-events",
                    "messaging.message.id": "5fea7756-0ea4-451a-a703-a558b933e274",
                  },
                  {
                    QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/order-events",
                    MessageBody: JSON.stringify({ type: "order.created", orderId }),
                  },
                  { MessageId: "5fea7756-0ea4-451a-a703-a558b933e274", MD5OfMessageBody: "a1b2" },
                ),
              },
              {
                name: "SNS.Publish",
                offset: 245,
                duration: 18 + r() * 10,
                attributes: aws(
                  "SNS",
                  "Publish",
                  {
                    "messaging.system": "aws_sns",
                    "messaging.destination.name": "order-notifications",
                    "messaging.message.id": "e6a5b4c3-1d2e-4f50-9a8b-7c6d5e4f3a2b",
                  },
                  {
                    TopicArn: "arn:aws:sns:eu-west-1:123456789012:order-notifications",
                    Subject: "Order confirmed",
                    Message: JSON.stringify({ orderId, email: "ada@example.com" }),
                  },
                  { MessageId: "e6a5b4c3-1d2e-4f50-9a8b-7c6d5e4f3a2b" },
                ),
              },
            ]),
      ];
    case "orders-processQueue":
      return [
        {
          name: "DynamoDB.UpdateItem",
          offset: 3,
          duration: 10 + r() * 10,
          status: failed ? "ERROR" : "OK",
          statusMessage: failed ? "ConditionalCheckFailedException: The conditional request failed" : "",
          attributes: {
            ...aws(
              "DynamoDB",
              "UpdateItem",
              { "aws.dynamodb.table_names": JSON.stringify(["checkout-orders"]) },
              {
                TableName: "checkout-orders",
                Key: { pk: { S: `ORDER#${orderId}` } },
                UpdateExpression: "SET #s = :s",
                ConditionExpression: "#s = :pending",
              },
              failed ? { __type: "ConditionalCheckFailedException" } : { Attributes: { status: { S: "paid" } } },
            ),
            ...(failed ? { "http.response.status_code": "400" } : {}),
          },
        },
        ...(failed
          ? []
          : [
              {
                name: "EventBridge.PutEvents",
                offset: 20,
                duration: 15 + r() * 10,
                attributes: aws(
                  "EventBridge",
                  "PutEvents",
                  {
                    "aws.eventbridge.bus": "commerce",
                    "aws.eventbridge.detail_types": JSON.stringify(["OrderPaid"]),
                  },
                  {
                    Entries: [
                      {
                        EventBusName: "commerce",
                        Source: "checkout.orders",
                        DetailType: "OrderPaid",
                        Detail: JSON.stringify({ orderId }),
                      },
                    ],
                  },
                  { FailedEntryCount: 0, Entries: [{ EventId: "11710aed-b79e-4468-a20b-bb3c0c3b4860" }] },
                ),
              },
              {
                name: "SESv2.SendEmail",
                offset: 40,
                duration: 60 + r() * 40,
                attributes: aws(
                  "SESv2",
                  "SendEmail",
                  {},
                  {
                    FromEmailAddress: "shop@example.com",
                    Destination: { ToAddresses: ["ada@example.com"] },
                    Content: { Simple: { Subject: { Data: "Your order is on its way" }, Body: {} } },
                  },
                  { MessageId: "0102018c-1234-abcd" },
                ),
              },
              {
                name: "Lambda.Invoke",
                offset: 110,
                duration: 40 + r() * 30,
                attributes: aws(
                  "Lambda",
                  "Invoke",
                  { "faas.invoked_name": "invoices-generate", "faas.invoked_region": "eu-west-1" },
                  { FunctionName: "invoices-generate", InvocationType: "Event", Payload: { orderId } },
                  { StatusCode: 202 },
                ),
              },
            ]),
      ];
    case "email-sendReceipt":
      return [
        {
          name: "SESv2.SendEmail",
          offset: 6,
          duration: 60 + r() * 40,
          status: failed ? "ERROR" : "OK",
          statusMessage: failed ? "MessageRejected: Email address is not verified." : "",
          attributes: aws(
            "SESv2",
            "SendEmail",
            {},
            { FromEmailAddress: "receipts@example.com", Destination: { ToAddresses: ["[redacted]"] } },
            failed ? { message: "Email address is not verified." } : { MessageId: "0100018c-receipt" },
            "eu-west-1",
          ),
        },
      ];
    case "reports-nightlyExport":
      return [
        {
          name: "SecretsManager.GetSecretValue",
          offset: 5,
          duration: 25,
          attributes: aws(
            "SecretsManager",
            "GetSecretValue",
            {},
            { SecretId: "reports/slack-webhook" },
            { Name: "reports/slack-webhook", SecretString: "[redacted]" },
            "us-east-1",
          ),
        },
        {
          name: "S3.ListObjectsV2",
          offset: 35,
          duration: 45,
          attributes: aws(
            "S3",
            "ListObjectsV2",
            { "aws.s3.bucket": "analytics-raw-us" },
            { Bucket: "analytics-raw-us", Prefix: "events/2026/11/" },
            { KeyCount: 24, IsTruncated: false },
            "us-east-1",
          ),
        },
        {
          name: "S3.GetObject",
          offset: 85,
          duration: 140,
          attributes: aws(
            "S3",
            "GetObject",
            { "aws.s3.bucket": "analytics-raw-us", "aws.s3.key": "events/2026/11/13.json.gz" },
            { Bucket: "analytics-raw-us", Key: "events/2026/11/13.json.gz" },
            { ContentLength: 5482211, ContentType: "application/gzip" },
            "us-east-1",
          ),
        },
        {
          name: "POST hooks.slack.com",
          offset: 240,
          duration: 90,
          attributes: http(
            "POST",
            "https://hooks.slack.com/services/T000/B000/[redacted]",
            200,
            { text: "Nightly export finished: 24 files" },
            "ok",
          ),
        },
      ];
    default:
      return [
        {
          name: "DynamoDB.GetItem",
          offset: 2,
          duration: 6 + r() * 6,
          attributes: aws(
            "DynamoDB",
            "GetItem",
            { "aws.dynamodb.table_names": JSON.stringify(["auth-sessions"]) },
            { TableName: "auth-sessions", Key: { pk: { S: "SESSION#s_77" } } },
            failed ? {} : { Item: { pk: { S: "SESSION#s_77" }, userId: { S: "u_8812" } } },
            "eu-central-1",
          ),
        },
      ];
  }
}

const logAt =
  (startMs: number) =>
  (offset: number, severity: string, message: string): SpanEvent => ({
    ts: iso(startMs + offset),
    name: "log",
    attributes: { "log.severity": severity, "log.message": message },
  });

/** The last log lines the extension attaches to failures outside the handler (Lambda's own lines included). */
function failureLogTail(inv: MockInvocation, startMs: number): SpanEvent[] {
  const log = logAt(startMs);
  const end = inv.duration_ms;
  switch (inv.failure_kind) {
    case "init_failed":
      return [
        log(end - 30, "info", "Loading templates from /var/task/templates"),
        log(
          end - 2,
          "error",
          `Uncaught Exception \t{"errorType":"Runtime.ImportModuleError","errorMessage":"Error: Cannot find module 'mjml'\\nRequire stack:\\n- /var/task/src/render.js\\n- /var/task/index.js","stack":["Runtime.ImportModuleError: Error: Cannot find module 'mjml'","Require stack:","- /var/task/src/render.js","- /var/task/index.js","    at _loadUserApp (file:///var/runtime/index.mjs:1087:17)","    at async UserFunction.js.module.exports.load (file:///var/runtime/index.mjs:1119:21)"]}`,
        ),
        log(end - 1, "info", `INIT_REPORT Init Duration: ${end} ms\tPhase: init\tStatus: error\tError Type: Runtime.ImportModuleError`),
      ];
    case "out_of_memory":
      return [
        log(140, "info", "Decompressing events/2026/11/13.json.gz (5.2 MB)"),
        log(end - 40, "error", "<--- Last few GCs --->"),
        log(end - 39, "error", "[8:0x6b2f1e0]   2163 ms: Mark-Compact 251.3 (258.7) -> 250.9 (259.4) MB, 412.6 / 0.0 ms  (average mu = 0.112) allocation failure"),
        log(end - 20, "error", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"),
        log(end - 1, "error", `RequestId: ${inv.request_id} Error: Runtime exited with error: signal: killed\nRuntime.OutOfMemory`),
      ];
    case "timed_out":
      return [
        log(140, "info", "Exporting 24 files to analytics-raw-us"),
        log(end - 1, "error", `${new Date(startMs + end).toISOString()} ${inv.request_id} Task timed out after 30.00 seconds`),
      ];
    default:
      return [];
  }
}

function logsFor(inv: MockInvocation, startMs: number): SpanEvent[] {
  const log = logAt(startMs);
  const logs = [log(1, "info", `Handling ${inv.trigger} event`), log(3, "debug", `requestId=${inv.request_id}`)];
  if (inv.function === "checkout-createOrder") {
    logs.push(log(33, "info", "Creating payment intent for cus_Q1w2e3 (4999 EUR)"));
    if (inv.status === "error") logs.push(log(160, "warn", "Stripe returned 402 card_declined"));
  }
  if (inv.function === SUPPORT_FUNCTION) logs.push(log(4, "info", "Answering ticket for cus_ada"));
  if (inv.function === TRIAGE_FUNCTION) logs.push(log(4, "info", "Triaging ticket tkt_4410"));
  if (inv.status === "error") logs.push(log(inv.duration_ms - 2, "error", `${inv.error_type}: ${inv.error_message}`));
  else logs.push(log(inv.duration_ms - 1, "info", "Done"));
  return logs;
}

const STACKS: Record<string, string> = {
  TypeError: `TypeError: Cannot read properties of undefined (reading 'id')
    at createOrder (/var/task/src/handlers/create-order.ts:48:31)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async handler (/var/task/src/handlers/create-order.ts:12:20)`,
  ConditionalCheckFailedException: `ConditionalCheckFailedException: The conditional request failed
    at throwDefaultError (/var/task/node_modules/@smithy/smithy-client/dist-cjs/index.js:838:20)
    at markPaid (/var/task/src/orders/mark-paid.ts:22:5)
    at async Runtime.handler (/var/task/src/handlers/process-queue.ts:17:7)`,
};

function triggerEvent(inv: MockInvocation): unknown {
  if (inv.function === SUPPORT_FUNCTION) return supportEvent();
  if (inv.function === TRIAGE_FUNCTION) return triageEvent();
  switch (inv.trigger) {
    case "aws:apigatewayv2":
      return {
        version: "2.0",
        routeKey: "POST /orders",
        rawPath: "/orders",
        headers: { "content-type": "application/json", authorization: "[redacted]" },
        requestContext: { http: { method: "POST", path: "/orders", sourceIp: "203.0.113.7" } },
        body: JSON.stringify({ cartId: "cart_91", paymentMethod: "pm_card_visa" }),
        isBase64Encoded: false,
      };
    case "aws:sqs":
      return {
        Records: [
          {
            messageId: "5fea7756-0ea4-451a-a703-a558b933e274",
            eventSource: "aws:sqs",
            eventSourceARN: "arn:aws:sqs:eu-west-1:123456789012:order-events",
            body: JSON.stringify({ type: "order.created", orderId: "ord_1" }),
          },
        ],
      };
    case "aws:scheduled":
      return { "detail-type": "Scheduled Event", source: "aws.events", time: inv.ts, detail: {} };
    default:
      return { resource: "/me", path: "/me", httpMethod: "GET", headers: { authorization: "[redacted]" } };
  }
}

/** Lambda report figures (billed duration, memory, init) as the API returns them after merging the update span. */
function reportAttributes(inv: MockInvocation): Record<string, string> {
  return {
    "ivy.billed_duration_ms": String(Math.ceil(inv.duration_ms + 1)),
    ...(inv.memory_used_mb !== null ? { "ivy.memory_max_used_mb": String(Math.round(inv.memory_used_mb)) } : {}),
    "ivy.memory_size_mb": String(MEMORY_MB),
    ...(inv.init_duration_ms !== null ? { "ivy.init_duration_ms": String(inv.init_duration_ms) } : {}),
  };
}

/** The extension's synthetic invocation span for an init failure: no tracer spans, only the platform's view. */
function initFailureSpan(inv: MockInvocation, resource: Record<string, string>, startMs: number): Span {
  return {
    span_id: inv.span_id,
    parent_span_id: "",
    name: inv.function,
    kind: "INTERNAL",
    service: inv.function,
    start: iso(startMs),
    end: iso(startMs + inv.duration_ms),
    duration_ms: inv.duration_ms,
    status_code: "ERROR",
    status_message: inv.error_message ?? "",
    attributes: {
      "ivy.invocation": "true",
      "ivy.synthetic": "true",
      "ivy.failure.phase": "init",
      "ivy.platform.status": "error",
      "error.type": inv.error_type ?? "Runtime.Unknown",
      "faas.invocation_id": inv.request_id,
      "faas.coldstart": "true",
      "faas.trigger": "other",
      "cloud.resource_id": `arn:aws:lambda:${inv.region}:123456789012:function:${inv.function}`,
      ...reportAttributes(inv),
    },
    resource,
    events: failureLogTail(inv, startMs),
  };
}

/** What the extension exports for an invocation still running past the threshold: the root only, no children yet. */
function inProgressSpan(inv: MockInvocation, resource: Record<string, string>, startMs: number): Span {
  const lastSeen = inv.last_seen ? Date.parse(inv.last_seen) : startMs + inv.duration_ms;
  return {
    span_id: inv.span_id,
    parent_span_id: "",
    name: inv.function,
    kind: "INTERNAL",
    service: inv.function,
    start: iso(startMs),
    end: iso(lastSeen),
    duration_ms: lastSeen - startMs,
    status_code: "UNSET",
    status_message: "",
    attributes: {
      "ivy.invocation": "true",
      "ivy.in_progress": "true",
      "faas.invocation_id": inv.request_id,
      "faas.coldstart": String(inv.cold_start),
      "cloud.resource_id": `arn:aws:lambda:${inv.region}:123456789012:function:${inv.function}`,
      ...(inv.deadline ? { "ivy.deadline_ms": String(Date.parse(inv.deadline)) } : {}),
      "ivy.last_seen_ms": String(lastSeen),
    },
    resource,
    events: [],
  };
}

export function buildTrace(inv: MockInvocation): Span[] {
  const r = rng(inv.seed + 1);
  const fn = FUNCTIONS.find((f) => f.name === inv.function) ?? FUNCTIONS[0];
  const startMs = new Date(inv.ts).getTime();
  const resource = {
    "service.name": inv.function,
    "cloud.provider": "aws",
    "cloud.platform": "aws_lambda",
    "cloud.region": inv.region,
    "cloud.account.id": "123456789012",
    "faas.name": inv.function,
    "faas.version": "$LATEST",
    "faas.max_memory": String(MEMORY_MB * 1024 * 1024),
    "telemetry.sdk.name": "ivy-layer",
  };
  const failed = inv.status === "error";
  const kind = inv.failure_kind;
  if (kind === "init_failed") return [initFailureSpan(inv, resource, startMs)];
  if (inv.status === "in_progress") return [inProgressSpan(inv, resource, startMs)];
  const isImport = fn.name === IMPORT_FUNCTION;
  const importScale = inv.duration_ms / IMPORT_TIMELINE_MS;
  const events: SpanEvent[] = isImport
    ? importLogs.map((e) => ({ ts: iso(startMs + e.offset * importScale), name: e.name, attributes: e.attributes }))
    : kind
      ? failureLogTail(inv, startMs)
      : logsFor(inv, startMs);
  if (failed && !kind) {
    events.push({
      ts: iso(startMs + inv.duration_ms - 1),
      name: "exception",
      attributes: {
        "exception.type": inv.error_type ?? "Error",
        "exception.message": inv.error_message ?? "",
        "exception.stacktrace":
          STACKS[inv.error_type ?? ""] ?? `${inv.error_type}: ${inv.error_message}\n    at handler (/var/task/index.js:1:1)`,
      },
    });
  }
  const root: Span = {
    span_id: inv.span_id,
    parent_span_id: "",
    name: inv.function,
    kind: fn.kind,
    service: inv.function,
    start: iso(startMs),
    end: iso(startMs + inv.duration_ms),
    duration_ms: inv.duration_ms,
    status_code: failed ? "ERROR" : "OK",
    status_message: failed ? (kind ? (inv.error_message ?? "") : `${inv.error_type}: ${inv.error_message}`) : "",
    attributes: {
      "ivy.invocation": "true",
      "faas.invocation_id": inv.request_id,
      "faas.coldstart": String(inv.cold_start),
      "faas.trigger": fn.http ? "http" : fn.trigger === "aws:sqs" ? "pubsub" : fn.trigger === "aws:s3" ? "datasource" : "timer",
      "ivy.trigger.source": inv.trigger,
      "cloud.resource_id": `arn:aws:lambda:${inv.region}:123456789012:function:${inv.function}`,
      ...(fn.http
        ? {
            "http.request.method": fn.http.method,
            "url.path": fn.http.path,
            "http.route": fn.http.route,
            "http.response.status_code": String(inv.http_status),
          }
        : {}),
      "ivy.payload.request": JSON.stringify(triggerEvent(inv)),
      "ivy.payload.response": failed
        ? ""
        : JSON.stringify(
            fn.name === SUPPORT_FUNCTION ? supportResponse() : fn.http ? { statusCode: 200, body: JSON.stringify({ ok: true }) } : null,
          ),
      ...(inv.memory_used_mb !== null && !kind ? { "ivy.memory_used_mb": String(inv.memory_used_mb) } : {}),
      ...(failed ? { "error.type": inv.error_type ?? "Error" } : {}),
      ...(kind ? { "ivy.failure.phase": "invoke", "ivy.platform.status": kind === "timed_out" ? "timeout" : "error" } : {}),
      ...reportAttributes(inv),
      ...(isImport ? importRootAttributes : {}),
    },
    resource,
    events,
  };

  const spans: Span[] = [root];
  const addScaled = (specs: AiSpanSpec[], scale: number) => {
    const add = (spec: AiSpanSpec, parent: string) => {
      const id = hex(r, 16);
      const s = startMs + spec.offset * scale;
      const duration = Math.round(spec.duration * scale * 10) / 10;
      spans.push({
        span_id: id,
        parent_span_id: parent,
        name: spec.name,
        kind: spec.kind ?? "CLIENT",
        service: inv.function,
        start: iso(s),
        end: iso(s + duration),
        duration_ms: duration,
        status_code: spec.status ?? "UNSET",
        status_message: spec.statusMessage ?? "",
        attributes: spec.attributes,
        resource,
        events: (spec.events ?? []).map((e) => ({ ts: iso(startMs + e.offset * scale), name: e.name, attributes: e.attributes })),
      });
      for (const child of spec.children ?? []) add(child, id);
    };
    for (const spec of specs) add(spec, inv.span_id);
    return spans.sort((a, b) => a.start.localeCompare(b.start));
  };
  if (isImport) return addScaled(importSpans, importScale);
  if (fn.name === SUPPORT_FUNCTION) {
    const ttft = Math.round((240 + r() * 260) * 10) / 10;
    return addScaled(supportSpans(failed, ttft), inv.duration_ms / supportTimeline(failed));
  }
  if (fn.name === TRIAGE_FUNCTION) return addScaled(triageSpans(), inv.duration_ms / TRIAGE_TIMELINE_MS);
  const scale = inv.duration_ms / 300;
  // A crash or timeout leaves only the calls made before it (the tracer's provisional snapshot).
  const children = childrenFor(inv, r).filter((spec) => !kind || spec.offset < 100);
  for (const spec of children) {
    const s = startMs + spec.offset * Math.min(scale, 1.5);
    const d = Math.round(Math.min(spec.duration, inv.duration_ms - spec.offset * Math.min(scale, 1.5) - 1) * 10) / 10;
    const duration = Math.max(d, 1);
    spans.push({
      span_id: hex(r, 16),
      parent_span_id: inv.span_id,
      name: spec.name,
      kind: spec.kind ?? "CLIENT",
      service: inv.function,
      start: iso(s),
      end: iso(s + duration),
      duration_ms: duration,
      status_code: spec.status ?? "OK",
      status_message: spec.statusMessage ?? "",
      attributes: spec.attributes,
      resource,
      events: spec.events ?? [],
    });
  }
  return spans.sort((a, b) => a.start.localeCompare(b.start));
}
