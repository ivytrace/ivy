# LLM spans

Ivy captures OpenTelemetry spans that libraries create (the Vercel AI SDK first, but anything using the
`@opentelemetry/api` package) and renders LLM calls: messages, tool calls, tokens and time to first
token. Attribute names are in `span-conventions.md` ("Library spans", "LLM spans").

## Capture: the OTel bridge (`packages/layer/src/lib/otel-bridge/`)

The layer still has no OpenTelemetry SDK. The bridge implements the small part of the API contract a
library needs:

- **Registration** (`register.ts`). Every copy of `@opentelemetry/api` (installed, nested under a library,
  or inlined by a bundler) finds the global tracer provider and context manager on the same object,
  `globalThis[Symbol.for('opentelemetry.js.api.1')]`. The bridge writes its provider (and, if none, its
  context manager) there, which is what `trace.setGlobalTracerProvider` does, without loading the package.
  If a provider is already registered (an OTel SDK started with `NODE_OPTIONS=--require …`, ADOT), the
  bridge does nothing.
- **When.** Before the user handler loads (`installOtelBridge` runs in `createTracer`). Libraries cache
  tracers at import time (`@ai-sdk/otel` calls `trace.getTracer('gen_ai')` in its constructor); a tracer
  taken from an API copy before registration is that copy's `ProxyTracer`, which only ever gets a delegate
  through that copy's own `setGlobalTracerProvider`, unreachable for nested and bundled copies. Registering
  first makes `getTracer` return the bridge's tracer directly. The cost: an app that registers its own
  provider while loading would find the slot taken. So when the app ships an OTel SDK
  (`node_modules/@opentelemetry/sdk-trace-base` exists) the bridge waits until the first invocation and
  registers only if the slot is still free. `IVY_CAPTURE_OTEL=false` turns it off.
- **Version.** API copies only read a global whose minor version is at least their own, and only register
  into one with exactly their version. The bridge uses the app's installed `@opentelemetry/api` version (at
  least 1.9.0, which the AI SDK pins), or 1.10.0 when there is none (bundled apps).
- **Context** (`context.ts`). An `AsyncLocalStorage` context manager like the SDK's, so `startActiveSpan`
  nesting and `context.with` work. The layer's tracer has no async context of its own (one invocation at a
  time, flat children), so this is the only one. The storage is created on first use, so async hooks stay
  off unless something starts an active span. Contexts are the API's `BaseContext` shape; the active span
  is read from `Symbol.for('OpenTelemetry Context Key SPAN')`, the key every API copy uses.
- **Spans** (`provider.ts`, `span.ts`). `startSpan` creates an Ivy child span through `Tracer.startChild`
  (so collapsing and the span limit apply, `layer.md` "Large invocations"). A parent from the bridge in the same invocation keeps the hierarchy;
  anything else (no parent, a remote parent, a span from an earlier invocation) hangs off the invocation
  span. Outside an invocation (module init) spans are non-recording. Kinds are shifted to OTLP numbering,
  `TimeInput` (hrtime, epoch ms, `performance.now()` ms, `Date`) is converted, status follows OTel (OK is
  final, UNSET ignored), `recordException` adds an `exception` event, and `error.type` is set on error.
- **Payload rules** (`attributes.ts`). Applied in the span's `finalize` hook, i.e. at flush time after the
  response: JSON strings are parsed, redacted by key and re-serialized; all strings are capped per attribute.
  Attributes whose own key matches `IVY_REDACT_KEYS` are replaced, except token counts
  (`ai.usage.promptTokens`, `gen_ai.usage.input_tokens`) and numbers of keys that only match `token`
  (`span-conventions.md`, "Payload capping and redaction").
- **Nesting the layer's spans.** After registration `tracer.startChild` is wrapped: when the active context
  holds a bridge span of the current invocation, new fetch/http/AWS SDK spans become its children, so the
  provider's `POST api.openai.com` sits under the model-call span and a tool's DynamoDB call under the tool.
- **Hook.** One import and one call in `handler.ts`; everything else is in `otel-bridge/` (keeps merges with
  work on the tracer and extension trivial).

### Cost

6.6 KB of the 39.8 KB `handler.mjs` (minified). Like the rest of the tracer it imports no builtin
statically (`node:async_hooks`, `node:fs`, `node:path` come from `process.getBuiltinModule` at first use;
see `layer.md`, "Tracer init"). Nothing runs per invocation unless a library creates spans. Registration
at init is an `existsSync`, at most one small `readFileSync` and a few object writes. A local A/B of the
handler's import + init with and without the bridge (30 alternating fresh processes each, two runs)
gave medians of 19.9/18.7 ms vs. 18.6/18.8 ms, i.e. within noise. Not yet measured on real Lambda.

### AI SDK versions

- AI SDK 3–6: `experimental_telemetry: { isEnabled: true }` per call; spans `ai.*` (tracer `ai`).
- AI SDK 7: OpenTelemetry moved to `@ai-sdk/otel`. Apps call `registerTelemetry(new OpenTelemetry())` once
  (GenAI semantic-convention spans `invoke_agent`, `step n`, `chat`, `execute_tool`) or
  `new LegacyOpenTelemetry()` (`ai.*` spans). Telemetry is on by default once an integration is registered.
- AI SDK 7 also publishes every call on the `ai:telemetry` `diagnostics_channel` tracing channel, even
  without a registered integration. Ivy does not subscribe to it yet (see "Later").

### Tests

`ai-sdk.test.ts` runs the real `ai` packages (6 as the `ai-v6` alias, and 7 with `@ai-sdk/otel`) with
their mock language models (`MockLanguageModelV3`/`V4`) through the bridge: generateText with a tool call,
then streamText. `bridge.test.ts` covers nesting, exceptions, caps and redaction, layer-span nesting,
non-recording spans, an existing provider and the off switch. The e2e harness runs both AI SDK versions in
the Lambda image (`example/ai/v6.mjs` fully bundled, `v7.mjs` with `@opentelemetry/api` left in
`node_modules`), with the tool's DynamoDB lookup going through the bundled AWS SDK. No LLM API is called.

## Amazon Bedrock

Apps that call Bedrock directly with the AWS SDK (`BedrockRuntimeClient`) create no OpenTelemetry spans; the
layer's AWS SDK middleware records them as AWS spans (`BedrockRuntime.InvokeModel`) with the command input and
output as payloads. Those become LLM calls in two places.

**Capture** (`packages/layer/src/lib/instrumentation/bedrock.ts`). For `InvokeModel`,
`InvokeModelWithResponseStream`, `Converse` and `ConverseStream` the middleware adds the GenAI attributes
(`span-conventions.md`, "LLM spans"): at the start `gen_ai.system = aws.bedrock`, operation, request model and
settings, so collapsing groups calls by provider + model like any LLM call (`signatureOf`); at the end usage,
finish reasons and response model, read from the body (Anthropic `usage.input_tokens`, Converse/Nova
`usage.inputTokens`, Llama `prompt_token_count`, Cohere `meta.billed_units`, Titan `inputTextTokenCount`,
OpenAI-style `usage.prompt_tokens`) or the `x-amzn-bedrock-*-token-count` response headers, so summary spans
sum their tokens. Streams are wrapped (`tapBedrockStream`): the app reads the same events, and when the
stream ends the span gets its end time, `gen_ai.response.time_to_first_chunk`, the final usage (Anthropic
`message_start`/`message_delta`, ConverseStream `metadata`, `amazon-bedrock-invocationMetrics`) and the
assembled response in the family's non-streaming shape as `ivy.payload.response`. Assembled text is capped at
256 KB per block. SDK copies the layer cannot patch (bundled) are seen as HTTP requests to
`bedrock-runtime.<region>.amazonaws.com/model/{id}/{invoke|converse|…}`: the HTTP span is named and tagged from
the URL at start and gets usage from the body and headers when finalized. About 7 KB of the minified
`handler.mjs`; nothing runs unless a Bedrock Runtime command is sent. Tests (`bedrock.test.ts`) drive the
real `@aws-sdk/client-bedrock-runtime` with a fake request handler, event streams encoded with smithy's
`EventStreamCodec`.

**Rendering** (`packages/spans/src/bedrock.ts`, called first by `describeLlm`). Works from the payloads, so
spans stored by older layers (HTTP-level ones too, whose `rpc.service` is `Bedrock` and title used to be the
region) render the same. The model comes from `gen_ai.request.model`, the SDK input's `modelId` or the URL,
else the response's `model`; it is shown short (`eu.anthropic.claude-haiku-5-5-20261001-v1:0` →
`claude-haiku-5-5`, the full ID as "Model ID"). Bodies are parsed by shape rather than by model ID: Anthropic
messages (system, content blocks, `tool_use`/`tool_result`, thinking), Converse and Amazon Nova content blocks
(`text`, `toolUse`, `toolResult`, `reasoningContent`, media), OpenAI-style `choices`, Llama
`prompt`/`generation`, Mistral `outputs`, Cohere `message`/`chat_history`/`preamble`/`text`, Titan
`inputText`/`results`. Settings: max tokens, temperature, top P/K, stop sequences, thinking budget, tool choice.
Provider is "Amazon Bedrock"; the model maker (`vendor`: Anthropic, Amazon, Meta, Mistral, Cohere, …) names the
graph node, `Bedrock · Anthropic`, one node per maker. A Bedrock request under an AI SDK model call (the
`@ai-sdk/amazon-bedrock` provider's fetch) belongs to that call's node and its tokens aren't counted twice.

**Gaps.** A stream the app never reads to the end leaves the span without an end (it is flushed as
`ivy.incomplete`). Streams of SDK copies the layer cannot patch are binary event streams at the HTTP level and
are not parsed, so those spans have no response or tokens. Token counts in bodies stored before the redaction
fix are `[redacted]`; the describer then falls back to the token-count headers when those were captured.

## Rendering (`@ivy/spans`, dashboard, MCP App views, `@ivy/format`)

- `describeLlm(span)` (`packages/spans/src/llm.ts`) normalizes the three attribute families into
  `LlmSpan` at read time; nothing is rewritten at ingest, so new instrumentations only need a describer
  change. `describeSpan` adds it as `llm`, gives LLM spans the `ai` icon, `serviceLabel` = provider,
  `operation` = SDK operation (`generateText`, `doGenerate`, `chat`, `tool`, `step 1`), target = model or
  tool name, and a note like `812 → 24 tokens · ttft 318ms · OpenAI`.
- `llmUsage(spans)` sums tokens per model, counting only spans with usage and no descendant with usage.
- Service graph: one node per provider (label = provider, `ai` icon, instance count = model calls). Agent
  steps and tool spans are not nodes; what a tool calls hangs off the function. Spans directly under a
  model call (the provider's HTTP request) belong to the provider node.
- Dashboard: timeline rows put an LLM span's note (tokens, ttft, provider) on a smaller second line, so
  it isn't cut off next to the model name. `components/trace/llm-details.tsx` shows settings chips, the conversation (role labels,
  text clamped at 600 characters / 10 lines with "Show all", fenced code, inline code and bold rendered as
  React text, never HTML), the response, tool calls and results as JSON trees, and the offered tools. The
  trace header shows `Tokens in → out` and the Overview tab an "LLM usage" table per model. The MCP App
  views reuse these components.
- `@ivy/format`: LLM lines like `ai.streamText.doStream claude-haiku-4-5 164→38 tok (ttft 318ms)` and
  `chat gpt-4o-mini 812→24 tok tool:getOrder`; the header gets `3 LLM calls 1877→103 tok`. `normal` detail
  adds the last input message and the response of each model call and the arguments/result of each tool
  span; `full` adds every message, including those of operations; `summary` none.
- Fixtures: `@ivy/format/fixtures` has `supportBot` (AI SDK 6 `ai.*`), `supportBotGenAi` (AI SDK 7
  GenAI) and `ticketTriage` (direct Bedrock: Anthropic on InvokeModel, Converse with a tool call, Nova); their
  attribute values (`@ivy/format/ai-fixtures`, including `bedrockAttributes.invokeModelHttp`, an older layer's
  HTTP-level capture) also feed the UI mock's `support-answerTicket` and `support-triageTicket` functions.
  Loadgen has `support-api-prod-answerTicket`.

## Gaps

- Apps that register their own tracer provider while loading but don't install `@opentelemetry/sdk-trace-base`
  (e.g. a vendor SDK bundling it) lose their registration to the bridge; `IVY_CAPTURE_OTEL=false` fixes it.
- A bundled `@opentelemetry/api` newer than 1.10 ignores the bridge's global (its minor is higher).
- Messages over `IVY_MAX_PAYLOAD_BYTES` are cut, so their JSON no longer parses; the UI then shows the raw
  text as one "prompt" message. Long conversations may need a higher limit.
- No cost estimates (prices per model change too often to hard-code).
- Response streaming handlers are still not traced at all (`layer.md`).

## Later

- Subscribe to AI SDK 7's `ai:telemetry` `diagnostics_channel` tracing channel and build spans from its
  lifecycle events, so AI SDK 7 apps are captured without installing and registering `@ai-sdk/otel`
  (skipping calls when an OpenTelemetry integration is registered, to avoid duplicates).
