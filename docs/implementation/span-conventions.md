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
- `ivy.memory_used_mb`: number (best effort, from the tracer; `ivy.memory_max_used_mb` from the platform report wins when present)
- Errors: span status `ERROR` with message, plus an `exception` event
  (`exception.type`, `exception.message`, `exception.stacktrace`). Also set
  `error.type` on the span. Timeouts: `error.type = "Timeout"` from the tracer, replaced by
  `Sandbox.Timedout` when the extension sees the platform's timeout.
- `ivy.init_duration_ms` (double): on cold starts, the init phase duration from the Lambda platform
  (`platform.initReport`). `ivy.restore_duration_ms` likewise for SnapStart restores.

### Failures outside the handler (from the extension)

The extension reads the Lambda Telemetry API (`platform-failures.md`) and adds these to the invocation span, or
creates the invocation span itself when the tracer reported nothing:

- `error.type`: the platform's error type, e.g. `Runtime.ImportModuleError`, `Runtime.HandlerNotFound`,
  `Runtime.UserCodeSyntaxError`, `Runtime.OutOfMemory`, `Runtime.ExitError`, `Sandbox.Timedout`.
- `ivy.failure.phase`: `init` (the function failed while loading; the handler never ran) or `invoke`.
- `ivy.platform.status`: the platform status, `failure` | `error` | `timeout`.
- `ivy.synthetic = true`: the extension created this span; there are no tracer spans (always for init failures).
- Status `ERROR`, message = the first meaningful log line (e.g. `Error: Cannot find module 'left-pad'`), which is
  what error groups are keyed on. No `exception` event.
- The log tail (last 50 lines / 8 KB, redacted) as `log` events, same shape as console logs below.
- `faas.invocation_id` is empty or absent for an init failure that had no request; the UI shows "no request".

Readers derive one of four labels (`failureKind` in `@ivy/spans`): "Init failed" (phase `init`, or an init error
type), "Out of memory" (`Runtime.OutOfMemory`), "Timed out" (`Sandbox.Timedout` or `Timeout`), "Crashed" (other
invoke-phase failures).

### Update spans (late Lambda report data)

`platform.report` (billed duration, max memory) only exists after the invoke phase has ended, i.e. after the
extension exported the invocation. The extension sends it with a later export as an **update span**: same
`traceId`, `spanId`, name and start/end time as the invocation span, with

- `ivy.update = true` **(marker; never together with `ivy.invocation`)**
- `faas.invocation_id`
- `ivy.billed_duration_ms` (int), `ivy.memory_max_used_mb` (int), `ivy.memory_size_mb` (int)
- optionally `ivy.init_duration_ms`, `ivy.restore_duration_ms`

Readers merge an update span's attributes into the span with the same span ID and drop the update span
(`mergeUpdateSpans`). It creates no `invocations` row and is not a trace for billing.

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
