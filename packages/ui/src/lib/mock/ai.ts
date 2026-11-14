import * as AI from "@ivy/format/ai-fixtures";

/**
 * Spans of `support-answerTicket`: API Gateway → Lambda calling the Vercel AI SDK's generateText with a
 * tool (a DynamoDB lookup), then streamText. Attribute values are the ones the layer captures from the
 * real SDK (shared with @ivy/format's fixtures). Offsets are in ms on a 2140 ms timeline; failed runs hit
 * the provider's rate limit on the second model call.
 */

export interface AiSpanSpec {
  name: string;
  kind?: "CLIENT" | "INTERNAL";
  offset: number;
  duration: number;
  attributes: Record<string, string>;
  status?: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  events?: { offset: number; name: string; attributes: Record<string, string> }[];
  children?: AiSpanSpec[];
}

export const SUPPORT_TIMELINE_MS = 2140;
export const RATE_LIMIT = {
  type: "AI_APICallError",
  message: "Rate limit reached for gpt-4o-mini in organization org-acme on tokens per min (TPM): Limit 200000, Used 199412, Requested 1290.",
};

const http = (host: string, path: string, status: number): Record<string, string> => ({
  "http.request.method": "POST",
  "url.full": `https://${host}${path}`,
  "server.address": host,
  "server.port": "443",
  "http.response.status_code": String(status),
  "ivy.http.request.headers": JSON.stringify({ "content-type": "application/json", authorization: "[redacted]" }),
  "ivy.http.response.headers": JSON.stringify({ "content-type": "application/json" }),
});

const orderLookup: AiSpanSpec = {
  name: "DynamoDB.GetItem",
  kind: "CLIENT",
  offset: 627,
  duration: 17.6,
  attributes: {
    "rpc.system": "aws-api",
    "rpc.service": "DynamoDB",
    "rpc.method": "GetItem",
    "cloud.region": "eu-west-1",
    "aws.request_id": "R8KQ2V0ORDERLOOKUP",
    "http.response.status_code": "200",
    "aws.dynamodb.table_names": JSON.stringify(["orders-prod"]),
    "ivy.payload.request": JSON.stringify({ TableName: "orders-prod", Key: { pk: { S: "ORDER#ord_8812" } } }),
    "ivy.payload.response": JSON.stringify({
      Item: { pk: { S: "ORDER#ord_8812" }, status: { S: "shipped" }, carrier: { S: "DHL" }, trackingNumber: { S: "JD014600006281" } },
    }),
  },
};

/** A model call that failed has no response or usage attributes, only the error. */
function failedAttributes(attributes: Record<string, string>): Record<string, string> {
  const kept = Object.entries(attributes).filter(([k]) => !/^(ai|gen_ai)\.(response|usage)\./.test(k));
  return { ...Object.fromEntries(kept), "error.type": RATE_LIMIT.type };
}

export function supportSpans(failed: boolean, ttftMs: number): AiSpanSpec[] {
  const exception = (offset: number): AiSpanSpec["events"] => [
    { offset, name: "exception", attributes: { "exception.type": RATE_LIMIT.type, "exception.message": RATE_LIMIT.message } },
  ];
  const secondCall: AiSpanSpec = failed
    ? {
        name: "ai.generateText.doGenerate",
        kind: "INTERNAL",
        offset: 650,
        duration: 212,
        status: "ERROR",
        statusMessage: RATE_LIMIT.message,
        attributes: failedAttributes(AI.aiSdkAttributes.doGenerate(2)),
        events: exception(861),
        children: [{ name: "POST api.openai.com", kind: "CLIENT", offset: 652, duration: 208, attributes: http("api.openai.com", "/v1/chat/completions", 429), status: "OK" }],
      }
    : {
        name: "ai.generateText.doGenerate",
        kind: "INTERNAL",
        offset: 650,
        duration: 987.5,
        attributes: AI.aiSdkAttributes.doGenerate(2),
        children: [{ name: "POST api.openai.com", kind: "CLIENT", offset: 652, duration: 983.1, attributes: http("api.openai.com", "/v1/chat/completions", 200) }],
      };

  const generate: AiSpanSpec = {
    name: "ai.generateText",
    kind: "INTERNAL",
    offset: 9,
    duration: failed ? 856 : 1630.2,
    attributes: failed
      ? failedAttributes(AI.aiSdkAttributes.generateText)
      : AI.aiSdkAttributes.generateText,
    ...(failed ? { status: "ERROR" as const, statusMessage: RATE_LIMIT.message, events: exception(864) } : {}),
    children: [
      {
        name: "ai.generateText.doGenerate",
        kind: "INTERNAL",
        offset: 11,
        duration: 611.4,
        attributes: AI.aiSdkAttributes.doGenerate(1),
        children: [{ name: "POST api.openai.com", kind: "CLIENT", offset: 13, duration: 606.8, attributes: http("api.openai.com", "/v1/chat/completions", 200) }],
      },
      { name: "ai.toolCall", kind: "INTERNAL", offset: 625, duration: 21.3, attributes: AI.aiSdkAttributes.toolCall, children: [orderLookup] },
      secondCall,
    ],
  };
  if (failed) return [generate];

  const stream: AiSpanSpec = {
    name: "ai.streamText",
    kind: "INTERNAL",
    offset: 1645,
    duration: 488.9,
    attributes: AI.aiSdkAttributes.streamText,
    children: [
      {
        name: "ai.streamText.doStream",
        kind: "INTERNAL",
        offset: 1647,
        duration: 485.2,
        attributes: AI.aiSdkAttributes.doStream(ttftMs),
        events: [
          { offset: 1647 + ttftMs, name: "ai.stream.firstChunk", attributes: { "ai.response.msToFirstChunk": String(ttftMs) } },
          { offset: 2131, name: "ai.stream.finish", attributes: {} },
        ],
        children: [{ name: "POST api.anthropic.com", kind: "CLIENT", offset: 1649, duration: 482.7, attributes: http("api.anthropic.com", "/v1/messages", 200) }],
      },
    ],
  };
  return [generate, stream];
}

export const supportEvent = () => ({
  version: "2.0",
  routeKey: "POST /support/messages",
  rawPath: "/support/messages",
  headers: { "content-type": "application/json", authorization: "[redacted]" },
  requestContext: { http: { method: "POST", path: "/support/messages", sourceIp: "203.0.113.7" } },
  body: JSON.stringify({ customerId: "cus_ada", message: AI.QUESTION }),
  isBase64Encoded: false,
});

export const supportResponse = () => ({ statusCode: 200, body: JSON.stringify({ reply: AI.REPLY }) });
