# Span conventions

The contract between producers (the Ivy layer, or any OTLP producer) and the backend
(ClickHouse materialized views, API, UI). Standard OpenTelemetry semantic conventions
are used wherever they exist; Ivy-specific data lives under `ivy.*`.

## Trace IDs

128-bit trace IDs whose first 8 hex chars are the big-endian unix timestamp in
seconds (like X-Ray: `673f1a2b` + 24 random hex chars). The backend uses this to
prune by time when looking a trace up by ID. Producers that don't follow this still
work, lookups are just slower.

## Resource attributes (per Lambda environment)

| attribute | example |
|---|---|
| `service.name` | function name, e.g. `checkout-api-prod-createOrder` |
| `cloud.provider` | `aws` |
| `cloud.platform` | `aws_lambda` |
| `cloud.region` | `eu-west-1` |
| `cloud.account.id` | `123456789012` (if known) |
| `faas.name` | function name |
| `faas.version` | `$LATEST` |
| `faas.max_memory` | memory limit in bytes |
| `telemetry.sdk.name` | `ivy-layer` |

## Invocation (root) span

One per invocation. It is the span the `invocations` table is built from.

- `ivy.invocation = true` **(marker; required)**
- kind: `SERVER` for HTTP triggers, `CONSUMER` for queue/stream triggers, else `INTERNAL`
- name: function name
- `faas.invocation_id`: AWS request ID
- `faas.coldstart`: bool
- `faas.trigger`: `http` | `pubsub` | `datasource` | `timer` | `other`
- `ivy.trigger.source`: `aws:apigateway` | `aws:apigatewayv2` | `aws:alb` | `aws:function-url` | `aws:sqs` | `aws:sns` | `aws:s3` | `aws:dynamodb` | `aws:eventbridge` | `aws:scheduled` | `aws:kinesis` | `aws:lambda` (direct) | `unknown`
- `cloud.resource_id`: invoked function ARN
- HTTP triggers: `http.request.method`, `url.path`, `http.route` (if known), `http.response.status_code`
- `ivy.payload.request`: event, JSON string, size-capped (see below)
- `ivy.payload.response`: handler result, JSON string, size-capped
- `ivy.memory_used_mb`: number (best effort)
- Errors: span status `ERROR` with message, plus an `exception` event
  (`exception.type`, `exception.message`, `exception.stacktrace`). Also set
  `error.type` on the span. Timeouts: `error.type = "Timeout"`.

## Outgoing call spans (children)

kind `CLIENT`.

AWS SDK calls (v3):
- name: `<Service>.<Operation>`, e.g. `DynamoDB.GetItem`
- `rpc.system = "aws-api"`, `rpc.service` (`DynamoDB`, `S3`, `SQS`, `SNS`, `Lambda`, `EventBridge`, `SES`, `SecretsManager`, …), `rpc.method` (`GetItem`)
- `cloud.region`, `aws.request_id`, `http.response.status_code`
- DynamoDB: `aws.dynamodb.table_names` (string array)
- S3: `aws.s3.bucket`, `aws.s3.key`
- SQS/SNS: `messaging.system` (`aws_sqs`/`aws_sns`), `messaging.destination.name` (queue name / topic name), `messaging.message.id`
- Lambda invoke: `faas.invoked_name`, `faas.invoked_region`
- EventBridge: `aws.eventbridge.bus`, `aws.eventbridge.detail_types` (string array)
- `ivy.payload.request` / `ivy.payload.response`: command input / output, JSON, capped

HTTP (fetch/undici, node:http, node:https), excluding calls to the Ivy endpoint and the Lambda runtime/extension APIs:
- name: `<METHOD> <host>`, e.g. `POST api.stripe.com`
- `http.request.method`, `url.full` (query string redacted per config), `server.address`, `server.port`, `http.response.status_code`
- `ivy.payload.request`, `ivy.payload.response`: bodies (text/JSON only, capped)
- `ivy.http.request.headers`, `ivy.http.response.headers`: JSON object strings, sensitive headers redacted

## Logs

`console.*` calls during an invocation become span events on the invocation span:
- event name `log`
- `log.severity`: `debug` | `info` | `warn` | `error`
- `log.message`: string, capped at 4 KB

## Payload capping and redaction

- Each `ivy.payload.*` value is capped at `IVY_MAX_PAYLOAD_BYTES` (default 16 KB).
  Truncated values end with `…[truncated N bytes]` and the span gets `ivy.payload.truncated = true`.
- Keys matching `IVY_REDACT_KEYS` (comma-separated, case-insensitive, default
  `password,secret,token,authorization,cookie,apikey,api_key,accesskey,secretaccesskey,sessiontoken,creditcard,cardnumber,cvv`)
  are replaced with `"[redacted]"` at any depth before serialization.
