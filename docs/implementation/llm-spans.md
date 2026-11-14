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
  (so the 1000-span cap applies). A parent from the bridge in the same invocation keeps the hierarchy;
  anything else (no parent, a remote parent, a span from an earlier invocation) hangs off the invocation
  span. Outside an invocation (module init) spans are non-recording. Kinds are shifted to OTLP numbering,
  `TimeInput` (hrtime, epoch ms, `performance.now()` ms, `Date`) is converted, status follows OTel (OK is
  final, UNSET ignored), `recordException` adds an `exception` event, and `error.type` is set on error.
- **Payload rules** (`attributes.ts`). Applied in the span's `finalize` hook, i.e. at flush time after the
  response: JSON strings are parsed, redacted by key and re-serialized; all strings are capped per attribute.
  String attributes whose own key matches `IVY_REDACT_KEYS` are replaced, but numbers are kept, because
  `token` is a default redaction key and token counts (`ai.usage.promptTokens`) must survive.
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
  without a registered integration. Ivy does not subscribe to it yet (see gaps).

### Tests

`ai-sdk.test.ts` runs the real `ai` packages (6 as the `ai-v6` alias, and 7 with `@ai-sdk/otel`) with
their mock language models (`MockLanguageModelV3`/`V4`) through the bridge: generateText with a tool call,
then streamText. `bridge.test.ts` covers nesting, exceptions, caps and redaction, layer-span nesting,
non-recording spans, an existing provider and the off switch. The e2e harness runs both AI SDK versions in
the Lambda image (`example/ai/v6.mjs` fully bundled, `v7.mjs` with `@opentelemetry/api` left in
`node_modules`), with the tool's DynamoDB lookup going through the bundled AWS SDK. No LLM API is called.

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
- Dashboard: `components/trace/llm-details.tsx` shows settings chips, the conversation (role labels,
  text clamped at 600 characters / 10 lines with "Show all", fenced code, inline code and bold rendered as
  React text, never HTML), the response, tool calls and results as JSON trees, and the offered tools. The
  trace header shows `Tokens in → out` and the Overview tab an "LLM usage" table per model. The MCP App
  views reuse these components.
- `@ivy/format`: LLM lines like `ai.streamText.doStream claude-haiku-4-5 164→38 tok (ttft 318ms)` and
  `chat gpt-4o-mini 812→24 tok tool:getOrder`; the header gets `3 LLM calls 1877→103 tok`. `normal` detail
  adds the last input message and the response of each model call and the arguments/result of each tool
  span; `full` adds every message, including those of operations; `summary` none.
- Fixtures: `@ivy/format/fixtures` has `supportBot` (AI SDK 6 `ai.*`) and `supportBotGenAi` (AI SDK 7
  GenAI); their attribute values (`@ivy/format/ai-fixtures`) also feed the UI mock's `support-answerTicket`
  function. Loadgen has `support-api-prod-answerTicket`.

## Gaps

- AI SDK 7 without `@ai-sdk/otel`: the `ai:telemetry` tracing channel could give zero-config capture.
- Apps that register their own tracer provider while loading but don't install `@opentelemetry/sdk-trace-base`
  (e.g. a vendor SDK bundling it) lose their registration to the bridge; `IVY_CAPTURE_OTEL=false` fixes it.
- A bundled `@opentelemetry/api` newer than 1.10 ignores the bridge's global (its minor is higher).
- Messages over `IVY_MAX_PAYLOAD_BYTES` are cut, so their JSON no longer parses; the UI then shows the raw
  text as one "prompt" message. Long conversations may need a higher limit.
- No cost estimates (prices per model change too often to hard-code).
- Response streaming handlers are still not traced at all (`layer.md`).
