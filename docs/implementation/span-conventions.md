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

### Set by the server, not by producers

| attribute | |
|---|---|
| `ivy.tenant_id` | the workspace (tenant) ID of the API key |
| `ivy.project_id` | the project ID of the API key (`prj_…`) |

Both are stamped server-side: the ingest router resolves the key and passes workspace and project to the
collector in headers, and the collector deletes whatever the client sent under these names and inserts the
header values (`tenancy.md`, `workspaces-projects.md`). Producers shouldn't set them; if they do, the values are
overwritten. They end up in `otel_traces.TenantId`/`ProjectId`. Spans without either are dropped.

The project of a Lambda function is chosen by which key it sends with (`IVY_API_KEY`); auto-trace writes the
right project's key (`auto-trace.md`). The tags `ivy:trace` and `ivy:project` on a function steer that, see there.

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

### Span limits, collapsing and payload budget

Set on the invocation span when the layer had to leave something out (`layer.md`, "Large invocations"):

- `ivy.collapsed_calls` (int): calls folded into summary spans (below).
- `ivy.dropped_spans` (int): child spans of this invocation that are not stored, and `ivy.dropped_spans.reason`
  (string, comma-separated): `span limit` (more than `IVY_MAX_SPANS` after collapsing), `queue full` or
  `export failed` (lost in the extension's export queue). When the invocation span had already been exported, the
  extension sends the new total in an update span (below), which readers merge.
- `ivy.trimmed_payload_bytes` (int) and `ivy.trimmed_payloads` (int): payload attributes left out because the
  invocation's payload budget ran out. Spans that lost payloads carry `ivy.payload.trimmed = true` (also used when a
  single span was larger than an export chunk).
- `ivy.dropped_logs` (int): console log events past 500.

Readers show "N spans omitted (reason)" for `ivy.dropped_spans`.

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

### Collapsed summary spans

When one invocation makes more than `IVY_COLLAPSE_THRESHOLD` (50) calls with the same signature under the same
parent, the tracer keeps the first `IVY_COLLAPSE_KEEP` (10), the `IVY_COLLAPSE_KEEP_SLOWEST` (3) slowest and every
failing call as ordinary spans, and replaces the rest with one summary span per signature. A collapsed call takes its
nested spans with it. Signatures: AWS service + operation + target (table, bucket, queue, topic, function, bus);
LLM operation + provider + model (bridge spans); HTTP method + host + route template (`/users/{id}`: numeric, UUID,
long hex and long mixed segments become `{id}`); otherwise the span name.

- name: `<name of the calls> × <count>`, e.g. `DynamoDB.PutItem × 1,184` (thousands separator `,`)
- kind and parent of the calls; start = start of the first collapsed call, end = end of the last one
- `ivy.collapsed.count` (int): calls the summary stands for (not the ones kept in full)
- `ivy.collapsed.duration_total_ms`, `ivy.collapsed.duration_max_ms`, `ivy.collapsed.duration_min_ms` (double)
- `ivy.collapsed.errors` (int): failing calls with this signature (all kept in full, never inside the summary)
- `ivy.collapsed.kept` (int): calls with this signature kept in full, failing ones included
- `ivy.collapsed.signature` (string), e.g. `DynamoDB.PutItem orders`, `POST api.openai.com /v1/chat/completions`
- `ivy.collapsed.spans` (int, optional): spans removed including nested ones, when more than the calls
- `ivy.collapsed.input_tokens`, `ivy.collapsed.output_tokens` (int, optional): summed tokens of collapsed LLM calls,
  from bridge usage attributes or, for plain HTTP calls to a model provider, from the `usage` in the response body.
  Readers count them in the trace's token totals (`llmUsage` counts the summary as `ivy.collapsed.count` calls).
- the calls' identifying attributes (`rpc.*`, `aws.*`, `messaging.*`, `http.request.method`, `server.address`,
  `gen_ai.*`/`ai.model.*`, …); no payloads.

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

## Library spans (OpenTelemetry API)

The layer registers a minimal global tracer provider on the `@opentelemetry/api` global (see
`llm-spans.md`), so spans that libraries create through the OpenTelemetry API become children of the
invocation span, keeping their own hierarchy. They keep their name, kind, attributes, events and status,
plus `otel.scope.name` (the library's tracer name, e.g. `ai`, `gen_ai`). Their string attributes follow the
payload rules: capped at `IVY_MAX_PAYLOAD_BYTES` each (with the `…[truncated N bytes]` suffix and
`ivy.payload.truncated = true`), JSON strings redacted by key at any depth, string values whose own key
matches `IVY_REDACT_KEYS` replaced (numbers such as token counts are kept). String arrays are capped per
element within 4 × `IVY_MAX_PAYLOAD_BYTES`. Spans of the layer's own instrumentation (fetch, http, AWS SDK)
started inside an active library span become its children.

## LLM spans

Read in `@ivy/spans` (`describeLlm`), never rewritten at ingest: the stored span keeps what the producer
sent, and the describer normalizes at read time. Ivy recognizes three attribute families.

**Vercel AI SDK** (`ai.*`; AI SDK 3–6 with `experimental_telemetry: { isEnabled: true }`, and AI SDK 7's
`LegacyOpenTelemetry`):

| span (`ai.operationId`) | kind |
|---|---|
| `ai.generateText`, `ai.streamText`, `ai.generateObject`, `ai.streamObject` | operation |
| `ai.generateText.doGenerate`, `ai.streamText.doStream`, … | model call |
| `ai.toolCall` | tool |
| `ai.embed`, `ai.embedMany`, `*.doEmbed` | embedding |

Attributes read: `ai.model.id`, `ai.model.provider` (`openai.chat`, `anthropic.messages`, …),
`ai.response.model`, `ai.telemetry.functionId`, `ai.prompt` (`{system, prompt, messages}`),
`ai.prompt.messages` (`[{role, content}]`, content parts `text`, `reasoning`, `tool-call`, `tool-result`,
`image`/`file`), `ai.prompt.tools`, `ai.prompt.toolChoice`, `ai.response.text`, `ai.response.object`,
`ai.response.toolCalls`, `ai.response.finishReason` (`ai.finishReason` before AI SDK 5),
`ai.usage.inputTokens`/`outputTokens`/`totalTokens`/`cachedInputTokens` (`promptTokens`/`completionTokens`
before AI SDK 5), `ai.usage.tokens` (embeddings), `ai.response.msToFirstChunk` (`ai.stream.msToFirstChunk`
before AI SDK 5, also on the `ai.stream.firstChunk` event), `ai.settings.*` (temperature, maxOutputTokens,
topP, topK, penalties, stopSequences, seed, maxRetries), `ai.toolCall.name`/`id`/`args`/`result`
(`input`/`output` accepted), `ai.value`/`ai.values`.

**OpenTelemetry GenAI semantic conventions** (`gen_ai.*`; AI SDK 7's `OpenTelemetry` from `@ai-sdk/otel`, the
OpenAI, Anthropic, Bedrock and LangChain instrumentations, OpenLLMetry):

- kind from `gen_ai.operation.name`: `invoke_agent`/`create_agent` operation, `agent_step` step,
  `execute_tool` tool, `embeddings` embedding, anything else (`chat`, `text_completion`,
  `generate_content`) model call. Spans without it but with `gen_ai.system`, `gen_ai.provider.name`,
  `gen_ai.request.model` or `llm.request.type` are model calls; `traceloop.span.kind = tool` is a tool.
- model and provider: `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name`
  (`gen_ai.system` in older versions), `gen_ai.agent.name`.
- messages: `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`
  (`[{role, parts}]`, parts `text`, `reasoning`, `tool_call`, `tool_call_response`, `blob`, `uri`); older
  indexed attributes `gen_ai.prompt.{i}.role|content`, `gen_ai.completion.{i}.role|content|finish_reason`,
  `gen_ai.completion.{i}.tool_calls.{j}.name|arguments`; older span events `gen_ai.{system,user,assistant,tool}.message`,
  `gen_ai.choice`, `gen_ai.content.prompt`/`gen_ai.content.completion`.
- usage: `gen_ai.usage.input_tokens`/`output_tokens` (`prompt_tokens`/`completion_tokens` in older versions),
  `gen_ai.usage.cache_read.input_tokens`, `llm.usage.total_tokens`.
- `gen_ai.response.finish_reasons`, `gen_ai.client.operation.time_to_first_chunk` (seconds),
  `gen_ai.request.temperature`/`max_tokens`/`top_p`/`top_k`/`frequency_penalty`/`presence_penalty`/
  `stop_sequences`/`seed`, `gen_ai.tool.definitions`.
- tools: `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`.

**OpenInference** (`openinference.span.kind` `LLM`/`TOOL`/`EMBEDDING`/`AGENT`): `llm.model_name`,
`llm.provider`/`llm.system`, `llm.input_messages.{i}.message.role|content`, `llm.output_messages.{i}.message.*`
(with `tool_calls.{j}.tool_call.function.name|arguments`), `llm.token_count.prompt|completion|total`,
`llm.invocation_parameters`, `tool.name`, `input.value`, `output.value`.

The normalized view (`LlmSpan`) uses GenAI names where they exist: kind, operation, provider (`openai`,
`anthropic`, `bedrock`, `vertex`, `google`, `azure-openai`, `mistral`, …, from `gen_ai.provider.name`,
`ai.model.provider` or `gen_ai.system`, falling back to the model name), model, response model, input/output/
total/cached tokens, time to first token, finish reasons, settings, input messages (system first), output
messages, the tool call of a tool span, and the tool definitions. Token totals of a trace count only spans
with usage and no descendant with usage, so operations don't double-count their model calls.
