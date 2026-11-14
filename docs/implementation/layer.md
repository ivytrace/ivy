# Lambda layer (`packages/layer`)

How the Node.js layer is put together and why. Usage is in `packages/layer/README.md`.

## Pieces

1. **Exec wrapper** (`/opt/ivy-wrapper`). If `IVY_ENDPOINT` is set it moves `_HANDLER` to
   `IVY_ORIGINAL_HANDLER` and points `_HANDLER` at `/opt/nodejs/ivy/handler.handler`, then
   `exec`s the runtime. Without an endpoint it changes nothing.
2. **In-process tracer** (`nodejs/ivy/handler.mjs`, from `src/handler.ts`). An ES module with
   top-level await: it says hello to the extension, installs instrumentation, then loads the
   user handler using the runtime's own lookup order (`.js` CJS, `.js` with `type: module`,
   `.mjs`, `.cjs`, then `require.resolve`), and exports a wrapped handler.
3. **Extension** (`extensions/ivy-extension`, from `src/extension.ts`). An external Lambda
   extension (separate Node process) registered for `INVOKE` and `SHUTDOWN`, with a localhost
   HTTP server (`127.0.0.1:9790`) that receives span batches from the tracer.

## In-process vs. extension split

The tracer builds spans in the function process (it has to: event, result, console and outgoing
calls only exist there). Exporting is done by the extension:

- After the handler settles, the wrapper records the end state synchronously and schedules a
  `setImmediate`. The Node 22 runtime posts the response synchronously from its own `.then`
  (native `done()`), so payload serialization and the localhost POST run after the response
  is already on its way.
- For each `INVOKE` event the extension waits until the tracer has sent the final batch for that
  request ID (bounded by the invocation deadline + 200 ms), then exports and only then calls
  `/next`. Lambda keeps the environment running until all extensions call `/next`, so export
  happens after the response without delaying it. It does add to billed duration (~1–5 ms to a
  healthy collector).
- The tracer only gets waited on after it said hello during init. If the wrapper is not active
  (layer attached, env var missing) the extension never blocks.
- If the hello fails (extension missing), the tracer falls back to exporting directly with the
  same queue, fire-and-forget after the response.

Why an external extension rather than only in-process flushing: an in-process flush racing the
freeze would either delay the response or be frozen mid-request, and only external extensions
receive `SHUTDOWN`. The extension is plain Node (no extra binary, works on both architectures);
the cost is its process start during init (see numbers below).

### Timeouts and crashes

The wrapper arms a timer at `remaining − IVY_TIMEOUT_MARGIN_MS` (default 100 ms). When it fires
it sends a provisional (non-final) snapshot with the root span marked `error.type = "Timeout"`.
If the handler finishes after all, the final batch replaces those spans by span ID in the
extension's store. If the function really times out, the extension's wait for the final batch
expires at the deadline (+200 ms), it exports the snapshot, and then receives `SHUTDOWN`
(reason `timeout`) as Lambda resets the environment, flushing anything left.

## Delivery

- OTLP/HTTP JSON to `<IVY_ENDPOINT>/v1/traces`, `Authorization: Bearer <IVY_API_KEY>`, gzip for
  bodies over 1 KB, keep-alive agent.
- Per flush: up to 3 attempts (timeout `IVY_EXPORT_TIMEOUT_MS`, backoff 100/300 ms) within
  `IVY_FLUSH_BUDGET_MS` (2 s). Retries on network errors, 408, 429, 5xx.
- When a flush fails the batch is dropped and counted, and the queue backs off (5 s doubling to
  5 min) so a dead endpoint costs one bounded attempt instead of one per invocation. Spans that
  arrive during backoff are buffered up to `IVY_MAX_QUEUE_SPANS` (oldest dropped first).
- The dropped count is attached as `ivy.dropped_spans` to the first span of the next successful
  export and logged by the extension.
- On `SHUTDOWN` the extension flushes with a 1.5 s budget, ignoring backoff.
- Every instrumentation path is wrapped in try/catch; errors from the user handler are rethrown
  as the same object; the extension catches its own errors and never exits during an invocation.

## Span model and encoding

Hand-rolled OTLP JSON encoder instead of the OpenTelemetry JS SDK. The layer needs one root span
plus flat children per invocation, no context propagation API, no samplers; the SDK plus OTLP
exporter would add a few hundred KB and noticeably more init time. The encoder is ~100 lines
(`src/lib/export/otlp.ts`): hex IDs, nanosecond strings via BigInt, int64 as strings.

Trace IDs: 8 hex chars of unix seconds + 24 random hex chars (`src/lib/utils/ids.ts`), random
bytes from a pooled `randomFillSync` buffer.

Payloads are kept as references and serialized at flush time (after the response): the event,
result, SDK input/output and HTTP bodies go through one `JSON.stringify` with a replacer that
redacts matching keys at any depth, decodes `Uint8Array` payloads that are UTF-8/JSON (Lambda
`Invoke`), replaces streams/binaries with placeholders, and breaks cycles. Then a UTF-8-safe byte
cap with the `…[truncated N bytes]` suffix. Unparseable bodies (truncated JSON, forms) get a
regex-based redaction pass. A key matches `IVY_REDACT_KEYS` if, lowercased with `-`/`_` removed,
it contains one of the entries (so `x-api-key` matches `api_key`).

Limits per invocation: 1000 child spans, 500 log events (4 KB each), request/response body
capture of `max(4 × IVY_MAX_PAYLOAD_BYTES, 64 KB)` for `node:http` and 1 MB for `fetch`
response clones; overflow is counted in `ivy.dropped_child_spans` / `ivy.dropped_logs`.

## Instrumentation

- **AWS SDK v3**: `Module._load` is hooked; when any copy of `@smithy/core/client` (current
  SDKs), `@smithy/smithy-client` or `@aws-sdk/smithy-client` is loaded, `Client.prototype.send`
  is patched to add two middlewares to each client's stack once: an `initialize` middleware that
  creates the `<Service>.<Operation>` span from `context.clientName/commandName` and records
  input/output/`$metadata`, and a `deserialize` middleware that marks the outgoing request's
  headers with a non-enumerable symbol so the `node:http` patch skips it (no duplicate span).
  This covers the runtime-provided SDK (`/var/runtime/node_modules`) and user-installed copies,
  including ESM handlers, because the SDK client packages are CommonJS and require smithy
  through `Module._load` even when imported from ESM.
- **Bundled SDKs** (esbuild/webpack inline smithy, so there is nothing to hook) still produce an
  AWS span: the HTTP instrumentation recognizes SigV4-signed requests and derives
  `rpc.service`/`cloud.region` from the credential scope, `rpc.method` from `X-Amz-Target` or
  `Action=`, and service attributes from the JSON body.
- **node:http / node:https**: `request` and `get` are wrapped (plus `syncBuiltinESMExports` for
  ESM named imports). Bodies are captured by wrapping `write`/`end` and the response's `emit`,
  so stream flow mode and error-listener semantics are untouched.
- **fetch**: `globalThis.fetch` is wrapped; response bodies are read from `res.clone()` when the
  content type is text-like and the length is ≤ 1 MB.
- **console**: `log/info/warn/error/debug/trace` become `log` events on the root span.
- Calls to the runtime API, the extension port and the Ivy endpoint (host + port) are skipped.

## Handler semantics

The wrapper keeps the user handler's arity and `AsyncFunction`-ness because the runtime reads
both (callback deprecation warning, "event loop empty but promise pending" handling). Callback
handlers keep `callbackWaitsForEmptyEventLoop` behaviour. Streaming handlers
(`awslambda.streamifyResponse`) are returned unwrapped (not traced yet). Layer frames are
stripped from error stacks.

## Verification

`pnpm --filter @ivy/layer e2e` asserts on the received spans (triggers, payloads, redaction,
SDK/fetch/http spans, bundled SDK, errors, timeout, unreachable endpoint). Run with
`IVY_ENDPOINT=http://host.docker.internal:4318` it was checked against the compose stack: the
spans land in `ivy.otel_traces` and the `ivy.invocations` view (status, trigger, HTTP fields,
cold start, `error_type = Timeout`).

## Size and overhead

Measured with `pnpm --filter @ivy/layer e2e` (RIE in Docker on an M-series Mac, so absolute
numbers are indicative only):

- `handler.mjs` 31 KB, `ivy-extension` 9 KB, `layer.zip` 17 KB.
- Warm invocation with three outgoing calls: runtime duration (response posted) ~3.0 ms traced
  vs ~2.8 ms without the layer, i.e. well under 1 ms.
- Init: +40–50 ms, of which ~30 ms is starting the extension's Node process (Lambda waits for
  extensions to register before it starts the runtime) and ~10 ms loading the tracer.

## Known gaps

- Extension cold-start cost; a compiled (Go/Rust) extension would cut most of the ~30 ms.
- No trace context propagation (incoming `traceparent`/X-Ray headers, outgoing injection).
- Undici used directly (`require('undici')`) and the SDK's `undici-http-handler` are not traced.
- Response streaming handlers and Lambda multi-concurrency (`AWS_LAMBDA_MAX_CONCURRENCY`) are
  not traced (the tracer assumes one invocation at a time).
- In the RIE the client response waits for extensions, so e2e round-trip latency includes the
  export; on Lambda it does not.
