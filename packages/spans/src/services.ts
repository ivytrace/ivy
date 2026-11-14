import { failureLabel, invocationResources, spanFailureKind } from "./failures.js";
import { describeLlm, formatTokens, llmNote, type LlmSpan } from "./llm.js";
import type { Span } from "./types.js";

export type ServiceIcon =
  | "ai"
  | "apigw"
  | "chargebee"
  | "cloudfront"
  | "cloudwatch"
  | "dynamodb"
  | "eventBridge"
  | "external"
  | "function"
  | "lambda"
  | "s3"
  | "ses"
  | "shopify"
  | "slack"
  | "sns"
  | "sqs"
  | "secretsmanager"
  | "aws"
  | "todoist";

export interface SpanField {
  label: string;
  value: string;
}

export interface SpanDescription {
  icon: ServiceIcon;
  serviceLabel: string;
  operation: string;
  target?: string;
  note?: string;
  fields: SpanField[];
  groupingKey: string;
  graphLabel: string;
  request?: unknown;
  response?: unknown;
  requestHeaders?: unknown;
  responseHeaders?: unknown;
  truncated: boolean;
  isInvocation: boolean;
  isError: boolean;
  /** LLM, agent, embedding and tool-call spans (see llm.ts). */
  llm?: LlmSpan;
}

const TRUNCATION_MARKER = /…\[truncated \d+ bytes\]$/;

export function parsePayload(value: string | undefined): unknown {
  if (value === undefined || value === "") return undefined;
  const stripped = value.replace(TRUNCATION_MARKER, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return value;
  }
}

export function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === "string") return [parsed];
  } catch {
    // not JSON, treat as comma-separated
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const get = (v: unknown, ...path: string[]): unknown => {
  let cur = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const compactJson = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));

const field = (label: string, value: string | undefined): SpanField[] =>
  value ? [{ label, value }] : [];

const TRIGGER_ICONS: Record<string, ServiceIcon> = {
  "aws:apigateway": "apigw",
  "aws:apigatewayv2": "apigw",
  "aws:alb": "external",
  "aws:function-url": "lambda",
  "aws:sqs": "sqs",
  "aws:sns": "sns",
  "aws:s3": "s3",
  "aws:dynamodb": "dynamodb",
  "aws:eventbridge": "eventBridge",
  "aws:scheduled": "eventBridge",
  "aws:kinesis": "aws",
  "aws:lambda": "lambda",
};

const TRIGGER_LABELS: Record<string, string> = {
  "aws:apigateway": "API Gateway",
  "aws:apigatewayv2": "API Gateway",
  "aws:alb": "Load Balancer",
  "aws:function-url": "Function URL",
  "aws:sqs": "SQS",
  "aws:sns": "SNS",
  "aws:s3": "S3",
  "aws:dynamodb": "DynamoDB Streams",
  "aws:eventbridge": "EventBridge",
  "aws:scheduled": "Schedule",
  "aws:kinesis": "Kinesis",
  "aws:lambda": "Lambda",
};

export function triggerIcon(source: string | undefined): ServiceIcon {
  return (source && TRIGGER_ICONS[source]) || "external";
}

export function triggerLabel(source: string | undefined): string {
  return (source && TRIGGER_LABELS[source]) || source || "unknown";
}

const AWS_SERVICE_ICONS: Record<string, ServiceIcon> = {
  dynamodb: "dynamodb",
  s3: "s3",
  sqs: "sqs",
  sns: "sns",
  lambda: "lambda",
  eventbridge: "eventBridge",
  cloudwatchevents: "eventBridge",
  ses: "ses",
  sesv2: "ses",
  secretsmanager: "secretsmanager",
  cloudwatch: "cloudwatch",
  cloudwatchlogs: "cloudwatch",
  cloudfront: "cloudfront",
  apigatewaymanagementapi: "apigw",
};

const HTTP_HOSTS: { match: (host: string) => boolean; icon: ServiceIcon; label: string }[] = [
  { match: (h) => h === "hooks.slack.com" || h === "slack.com", icon: "slack", label: "Slack" },
  { match: (h) => h.endsWith(".chargebee.com"), icon: "chargebee", label: "Chargebee" },
  { match: (h) => h.endsWith(".myshopify.com"), icon: "shopify", label: "Shopify" },
  { match: (h) => h === "api.todoist.com", icon: "todoist", label: "Todoist" },
  { match: (h) => h === "cloudfront.amazonaws.com", icon: "cloudfront", label: "CloudFront" },
  { match: (h) => /\.s3[.-]([\w-]+\.)?amazonaws\.com$/.test(h), icon: "s3", label: "S3" },
  { match: (h) => /^email\.[\w-]+\.amazonaws\.com$/.test(h), icon: "ses", label: "SES" },
  { match: (h) => /^events\.[\w-]+\.amazonaws\.com$/.test(h), icon: "eventBridge", label: "EventBridge" },
];

function hostOf(span: Span): string | undefined {
  const a = span.attributes;
  if (a["server.address"]) return a["server.address"];
  if (a["url.full"]) {
    try {
      return new URL(a["url.full"]).hostname;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function queueNameFromUrl(url: string | undefined): string | undefined {
  return url?.split("/").pop() || undefined;
}

function topicNameFromArn(arn: string | undefined): string | undefined {
  return arn?.split(":").pop() || undefined;
}

type Partial = Pick<SpanDescription, "target" | "note" | "fields"> & {
  graphLabel?: string;
  groupingExtra?: string;
};

function describeDynamoDB(span: Span, req: unknown, res: unknown): Partial {
  const tables = parseStringArray(span.attributes["aws.dynamodb.table_names"]);
  const tableFromReq = str(get(req, "TableName"));
  const target = tables.length ? tables.join(", ") : tableFromReq;

  let note: string | undefined;
  const count = get(res, "Count");
  const items = get(res, "Items");
  if (typeof count === "number") note = `${plural(count, "item")} returned`;
  else if (Array.isArray(items)) note = `${plural(items.length, "item")} returned`;
  else if (span.attributes["rpc.method"] === "GetItem" && isRecord(res))
    note = isRecord(res.Item) ? "1 item returned" : "item not found";

  const responses = get(res, "Responses");
  if (!note && isRecord(responses)) {
    const n = Object.values(responses).reduce<number>(
      (acc, v) => acc + (Array.isArray(v) ? v.length : 0),
      0,
    );
    note = `${plural(n, "item")} returned`;
  }

  return {
    target,
    note,
    graphLabel: target,
    fields: [
      ...field("Table", target),
      ...field("Index", str(get(req, "IndexName"))),
      ...field("Key", compactJson(get(req, "Key"))),
      ...field("Condition", str(get(req, "KeyConditionExpression"))),
      ...field("Filter", str(get(req, "FilterExpression"))),
      ...field("Scanned", str(get(res, "ScannedCount"))),
    ],
  };
}

function describeS3(span: Span, req: unknown, res: unknown): Partial {
  const bucket = span.attributes["aws.s3.bucket"] ?? str(get(req, "Bucket"));
  const key = span.attributes["aws.s3.key"] ?? str(get(req, "Key"));
  const target = bucket ? (key ? `s3://${bucket}/${key}` : `s3://${bucket}`) : undefined;
  const size = str(get(res, "ContentLength"));
  const contentType = str(get(res, "ContentType")) ?? str(get(req, "ContentType"));
  const listed = get(res, "KeyCount") ?? (Array.isArray(get(res, "Contents")) ? (get(res, "Contents") as unknown[]).length : undefined);
  let note: string | undefined;
  if (typeof listed === "number") note = `${plural(listed, "object")} listed`;
  else if (size) note = `${Number(size).toLocaleString("en")} bytes`;
  return {
    target,
    note,
    graphLabel: bucket,
    groupingExtra: key,
    fields: [
      ...field("Bucket", bucket),
      ...field("Key", key),
      ...field("Prefix", str(get(req, "Prefix"))),
      ...field("Content type", contentType),
      ...field("Size", size ? `${size} bytes` : undefined),
      ...field("ETag", str(get(res, "ETag"))),
    ],
  };
}

function describeSQS(span: Span, req: unknown, res: unknown): Partial {
  const queue =
    span.attributes["messaging.destination.name"] ?? queueNameFromUrl(str(get(req, "QueueUrl")));
  const messageId = span.attributes["messaging.message.id"] ?? str(get(res, "MessageId"));
  const entries = get(req, "Entries");
  const received = get(res, "Messages");
  let note: string | undefined;
  if (Array.isArray(received)) note = `${plural(received.length, "message")} received`;
  else if (Array.isArray(entries)) note = `${plural(entries.length, "message")}`;
  else if (messageId) note = `message ${messageId}`;
  return {
    target: queue,
    note,
    graphLabel: queue,
    fields: [
      ...field("Queue", queue),
      ...field("Queue URL", str(get(req, "QueueUrl"))),
      ...field("Message ID", messageId),
      ...field("Message group", str(get(req, "MessageGroupId"))),
      ...field("Delay", str(get(req, "DelaySeconds"))),
    ],
  };
}

function describeSNS(span: Span, req: unknown, res: unknown): Partial {
  const topic =
    span.attributes["messaging.destination.name"] ??
    topicNameFromArn(str(get(req, "TopicArn")) ?? str(get(req, "TargetArn")));
  const messageId = span.attributes["messaging.message.id"] ?? str(get(res, "MessageId"));
  const subject = str(get(req, "Subject"));
  const phone = str(get(req, "PhoneNumber"));
  return {
    target: topic ?? phone,
    note: subject ? `“${subject}”` : messageId ? `message ${messageId}` : undefined,
    graphLabel: topic ?? phone,
    fields: [
      ...field("Topic", topic),
      ...field("Topic ARN", str(get(req, "TopicArn"))),
      ...field("Phone number", phone),
      ...field("Subject", subject),
      ...field("Message ID", messageId),
    ],
  };
}

function describeLambda(span: Span, req: unknown, res: unknown): Partial {
  const fn = span.attributes["faas.invoked_name"] ?? str(get(req, "FunctionName"));
  const invocationType = str(get(req, "InvocationType"));
  const functionError = str(get(res, "FunctionError"));
  const status = str(get(res, "StatusCode")) ?? span.attributes["http.response.status_code"];
  let note: string | undefined;
  if (functionError) note = `function error: ${functionError}`;
  else if (invocationType === "Event") note = "async";
  else if (status) note = `status ${status}`;
  return {
    target: fn,
    note,
    graphLabel: fn,
    fields: [
      ...field("Function", fn),
      ...field("Region", span.attributes["faas.invoked_region"]),
      ...field("Invocation type", invocationType),
      ...field("Function error", functionError),
    ],
  };
}

function describeEventBridge(span: Span, req: unknown, res: unknown): Partial {
  const entries = get(req, "Entries");
  const firstBus = Array.isArray(entries) ? str(get(entries[0], "EventBusName")) : undefined;
  const bus = span.attributes["aws.eventbridge.bus"] ?? firstBus ?? "default";
  let types = parseStringArray(span.attributes["aws.eventbridge.detail_types"]);
  if (!types.length && Array.isArray(entries))
    types = [...new Set(entries.map((e) => str(get(e, "DetailType"))).filter((t): t is string => !!t))];
  const failed = get(res, "FailedEntryCount");
  let note = types.length ? types.join(", ") : undefined;
  if (typeof failed === "number" && failed > 0) note = `${note ? `${note} – ` : ""}${failed} failed`;
  return {
    target: bus,
    note,
    graphLabel: bus === "default" ? "EventBridge" : bus,
    fields: [
      ...field("Event bus", bus),
      ...field("Detail types", types.join(", ") || undefined),
      ...field("Entries", Array.isArray(entries) ? String(entries.length) : undefined),
      ...field("Sources", Array.isArray(entries) ? [...new Set(entries.map((e) => str(get(e, "Source"))).filter(Boolean))].join(", ") || undefined : undefined),
    ],
  };
}

function describeSES(_span: Span, req: unknown, res: unknown): Partial {
  const to = get(req, "Destination", "ToAddresses");
  const recipients = Array.isArray(to) ? to.map(String).join(", ") : undefined;
  const subject =
    str(get(req, "Content", "Simple", "Subject", "Data")) ??
    str(get(req, "Message", "Subject", "Data")) ??
    str(get(req, "Content", "Template", "TemplateName")) ??
    str(get(req, "Template"));
  const from = str(get(req, "FromEmailAddress")) ?? str(get(req, "Source"));
  return {
    target: recipients,
    note: subject ? `“${subject}”` : undefined,
    graphLabel: "SES",
    fields: [
      ...field("From", from),
      ...field("To", recipients),
      ...field("Subject", subject),
      ...field("Message ID", str(get(res, "MessageId"))),
    ],
  };
}

function describeSecretsManager(_span: Span, req: unknown): Partial {
  const secret = str(get(req, "SecretId")) ?? str(get(req, "Name"));
  return { target: secret, graphLabel: secret, fields: field("Secret", secret) };
}

const AWS_DESCRIBERS: Record<string, (span: Span, req: unknown, res: unknown) => Partial> = {
  dynamodb: describeDynamoDB,
  s3: describeS3,
  sqs: describeSQS,
  sns: describeSNS,
  lambda: describeLambda,
  eventbridge: describeEventBridge,
  cloudwatchevents: describeEventBridge,
  ses: describeSES,
  sesv2: describeSES,
  secretsmanager: describeSecretsManager,
};

const normalizeService = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function describeAws(span: Span, req: unknown, res: unknown) {
  const a = span.attributes;
  const service = a["rpc.service"] || span.name.split(".")[0] || "AWS";
  const key = normalizeService(service);
  const operation = a["rpc.method"] || span.name.split(".")[1] || span.name;
  const specific = AWS_DESCRIBERS[key]?.(span, req, res) ?? { fields: [] };
  return {
    icon: AWS_SERVICE_ICONS[key] ?? ("aws" as ServiceIcon),
    serviceLabel: service,
    operation,
    ...specific,
    graphLabel: specific.graphLabel || service,
    groupingKey: ["aws", key, operation, specific.target ?? "", specific.groupingExtra ?? ""].join("|"),
    fields: [
      ...specific.fields,
      ...field("Region", a["cloud.region"]),
      ...field("Status", a["http.response.status_code"]),
      ...field("Request ID", a["aws.request_id"]),
    ],
  };
}

function describeHttp(span: Span) {
  const a = span.attributes;
  const method = a["http.request.method"] || span.name.split(" ")[0] || "GET";
  const host = hostOf(span) ?? span.name.split(" ")[1] ?? "";
  const known = HTTP_HOSTS.find((h) => h.match(host));
  const status = a["http.response.status_code"];
  let path = "";
  try {
    if (a["url.full"]) path = new URL(a["url.full"]).pathname;
  } catch {
    path = "";
  }
  return {
    icon: known?.icon ?? ("external" as ServiceIcon),
    serviceLabel: known?.label ?? "HTTP",
    operation: method,
    target: a["url.full"] || host,
    note: status ? `status ${status}` : undefined,
    graphLabel: known?.label ?? host,
    groupingKey: ["http", host, method, path].join("|"),
    fields: [
      ...field("URL", a["url.full"]),
      ...field("Host", host),
      ...field("Port", a["server.port"]),
      ...field("Status", status),
    ],
  };
}

function describeLlmSpan(span: Span, l: LlmSpan) {
  const internal = l.kind === "tool" || l.kind === "step";
  const label = l.providerLabel ?? "LLM";
  const tokens =
    l.inputTokens !== undefined || l.outputTokens !== undefined
      ? `${formatTokens(l.inputTokens ?? 0)} in → ${formatTokens(l.outputTokens ?? 0)} out` +
        (l.totalTokens !== undefined ? ` (${formatTokens(l.totalTokens)} total)` : "")
      : undefined;
  const fields = [
    ...field("Model", l.model),
    ...field("Response model", l.responseModel),
    ...field("Tokens", tokens),
    ...field("Cached input", l.cachedInputTokens !== undefined ? formatTokens(l.cachedInputTokens) : undefined),
    ...field("Time to first token", l.ttftMs !== undefined ? `${Math.round(l.ttftMs)} ms` : undefined),
    ...field("Finish reason", l.finishReason),
    ...field("Function ID", l.functionId),
    ...field("Tool", l.tool?.name),
    ...field("Tool call ID", l.tool?.id),
  ];
  const note = llmNote(l);
  return {
    icon: "ai" as ServiceIcon,
    serviceLabel: internal ? "AI" : label,
    operation: l.operation,
    target: l.kind === "tool" ? l.tool?.name : l.kind === "step" ? undefined : l.model,
    note: internal ? note : [note, l.providerLabel].filter(Boolean).join(" · ") || undefined,
    graphLabel: internal ? span.name : label,
    groupingKey: internal ? ["llm-internal", span.name].join("|") : ["llm", l.provider ?? l.model ?? "unknown"].join("|"),
    fields,
  };
}

function describeInvocation(span: Span) {
  const a = span.attributes;
  const source = a["ivy.trigger.source"];
  const method = a["http.request.method"];
  const route = a["http.route"] || a["url.path"];
  const status = a["http.response.status_code"];
  const kind = spanFailureKind(span);
  const res = invocationResources(span);
  const msText = (v: number | null) => (v === null ? undefined : `${Math.round(v * 10) / 10} ms`);
  const memory =
    res.memoryUsedMb === null ? undefined : `${res.memoryUsedMb} MB${res.memoryLimitMb !== null ? ` of ${res.memoryLimitMb} MB` : ""}`;
  return {
    icon: "function" as ServiceIcon,
    serviceLabel: "Lambda",
    operation: "Invocation",
    target: span.name,
    note:
      kind === "init_failed"
        ? "init failed"
        : method && route
          ? `${method} ${route}${status ? ` – ${status}` : ""}`
          : `triggered by ${triggerLabel(source)}`,
    graphLabel: span.name,
    groupingKey: ["invocation", span.span_id].join("|"),
    fields: [
      ...field("Function", span.name),
      ...field("Request ID", a["faas.invocation_id"] || (kind === "init_failed" ? "none (failed before a request)" : undefined)),
      ...field("Failure", kind ? `${failureLabel(kind)} (${a["ivy.failure.phase"] || "invoke"} phase)` : undefined),
      ...field("Trigger", source),
      ...field("Cold start", a["faas.coldstart"]),
      ...field("Memory used", memory),
      ...field("Billed duration", msText(res.billedDurationMs)),
      ...field("Init duration", msText(res.initDurationMs)),
      ...field("Restore duration", msText(res.restoreDurationMs)),
      ...field("Region", span.resource["cloud.region"]),
      ...field("ARN", a["cloud.resource_id"]),
    ],
  };
}

export const isInvocationSpan = (span: Span) => span.attributes["ivy.invocation"] === "true";
export const isAwsSpan = (span: Span) => span.attributes["rpc.system"] === "aws-api";
export const isHttpSpan = (span: Span) =>
  span.kind === "CLIENT" && !!(span.attributes["http.request.method"] || span.attributes["url.full"]);

export function describeSpan(span: Span): SpanDescription {
  const a = span.attributes;
  const request = parsePayload(a["ivy.payload.request"]);
  const response = parsePayload(a["ivy.payload.response"]);
  const llm = isInvocationSpan(span) ? undefined : describeLlm(span);
  const base = isInvocationSpan(span)
    ? describeInvocation(span)
    : llm
      ? describeLlmSpan(span, llm)
      : isAwsSpan(span)
      ? describeAws(span, request, response)
      : isHttpSpan(span)
        ? describeHttp(span)
        : {
            icon: "function" as ServiceIcon,
            serviceLabel: span.kind === "INTERNAL" ? "Internal" : span.kind,
            operation: span.name,
            target: undefined,
            note: undefined,
            graphLabel: span.name,
            groupingKey: ["span", span.name].join("|"),
            fields: [] as SpanField[],
          };

  return {
    ...base,
    request,
    response,
    requestHeaders: parsePayload(a["ivy.http.request.headers"]),
    responseHeaders: parsePayload(a["ivy.http.response.headers"]),
    truncated: a["ivy.payload.truncated"] === "true",
    isInvocation: isInvocationSpan(span),
    isError: span.status_code === "ERROR",
    llm,
  };
}

export interface SpanException {
  type: string;
  message: string;
  stacktrace?: string;
}

export function getException(span: Span): SpanException | undefined {
  const event = span.events.find((e) => e.name === "exception");
  if (event) {
    return {
      type: event.attributes["exception.type"] || span.attributes["error.type"] || "Error",
      message: event.attributes["exception.message"] || span.status_message,
      stacktrace: event.attributes["exception.stacktrace"],
    };
  }
  if (span.status_code === "ERROR") {
    return { type: span.attributes["error.type"] || "Error", message: span.status_message };
  }
  return undefined;
}

export interface LogLine {
  ts: string;
  severity: "debug" | "info" | "warn" | "error" | string;
  message: string;
  spanId: string;
}

export function getLogs(spans: Span[]): LogLine[] {
  return spans
    .flatMap((span) =>
      span.events
        .filter((e) => e.name === "log")
        .map((e) => ({
          ts: e.ts,
          severity: e.attributes["log.severity"] || "info",
          message: e.attributes["log.message"] ?? "",
          spanId: span.span_id,
        })),
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
