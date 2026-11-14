# Lambda layer (`packages/layer`)

How the Node.js layer is put together and why. Usage is in `packages/layer/README.md`.

## Pieces

1. **Exec wrapper** (`/opt/ivy-wrapper`). If `IVY_ENDPOINT` is set it moves `_HANDLER` to
   `IVY_ORIGINAL_HANDLER` and points `_HANDLER` at `/opt/nodejs/ivy/handler.handler`, then
   `exec`s the runtime. Without an endpoint it changes nothing.
2. **In-process tracer** (`nodejs/ivy/handler.mjs`, from `src/handler.ts`). An ES module with
   top-level await: it sends a hello to the extension (without waiting for the answer), installs
   instrumentation, then loads the user handler using the runtime's own lookup order (`.js` CJS,
   `.js` with `type: module`, `.mjs`, `.cjs`, then `require.resolve`), and exports a wrapped handler.
3. **Extension** (`extensions/ivy-extension` → `ivy/bin/ivy-extension-<arch>`, from
   `extension/`). An external Lambda extension written in Rust, registered for `INVOKE` and
   `SHUTDOWN`, with a localhost HTTP server (`127.0.0.1:9790`) that receives span batches from
   the tracer. See "Extension in Rust" below. It also subscribes to the Lambda Telemetry API
   (platform events plus a small in-memory tail of function logs) to report failures outside the
   handler: init errors, crashes, out of memory and timeouts. See `platform-failures.md`.

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
- The extension only waits for spans once the tracer is attached (it said hello, or sent spans).
  The tracer does not hold up init for the hello's answer, so the hello can arrive just after the
  first `INVOKE`; when `AWS_LAMBDA_EXEC_WRAPPER` points at `ivy-wrapper` the extension expects a
  tracer and waits up to 500 ms for its hello at the first `INVOKE` (in parallel with the
  handler, so it delays nothing in practice). Without the wrapper the extension never blocks.
- **Startup order.** The extension binds its intake on 127.0.0.1 *before* it calls `register`.
  Lambda starts the runtime's init as soon as every extension has registered, so binding afterwards
  let a fast tracer's hello reach a closed port. That race hit real cold starts: the tracer then
  switched to exporting directly from the runtime, which Lambda freezes right after the response, so
  nothing was delivered, and the extension, without a hello, did not wait for spans either. Binding
  first costs nothing measurable.
- **When the hello fails anyway.** If the exec wrapper is active and `/opt/extensions/ivy-extension`
  exists, the tracer never switches to direct export: it repeats the hello once at the start of the
  first invocation and always hands spans to the intake, retrying the connection briefly (50/150/300 ms).
  A batch that still cannot be delivered is reported with one `[ivy]` line, even without `IVY_DEBUG`.
  On the extension side a `/spans` batch counts as a hello, and with the wrapper configured and the
  Telemetry API available it waits for each invocation's spans even when no hello came (the wait ends
  when the platform reports the runtime done). Direct export is only used without the extension.
  The e2e case `late-intake` opens the intake 400 ms after registering (test-only
  `IVY_TEST_INTAKE_DELAY_MS`) and checks that spans still go through the extension.

Why an external extension rather than only in-process flushing: an in-process flush racing the
freeze would either delay the response or be frozen mid-request, and only external extensions
receive `SHUTDOWN`. The cost is its process start during init, because Lambda waits for every
extension to register before it starts the runtime.

### Timeouts and crashes

The wrapper arms a timer at `remaining − IVY_TIMEOUT_MARGIN_MS` (default 100 ms). When it fires
it sends a provisional (non-final) snapshot with the root span marked `error.type = "Timeout"`.
If the handler finishes after all, the final batch replaces those spans by span ID in the
extension's store. If the function really times out, the extension's wait for the final batch
expires at the deadline (+200 ms), it exports the snapshot, and then receives `SHUTDOWN`
(reason `timeout`) as Lambda resets the environment, flushing anything left.

With the Telemetry API (`platform-failures.md`) the extension learns about the timeout from
`platform.runtimeDone` (`status: timeout`) and stops waiting at once; it completes the snapshot's root
with `error.type = Sandbox.Timedout`, the end time and the function's last log lines. A crash or out
of memory, where the process dies and the tracer sends nothing, becomes a synthetic invocation span
the same way, and so does a failed init.

## Extension in Rust

The extension was first a Node script; starting a second Node process added ~30 ms to every
cold start (measured: 47 ms from spawn to `register` in Docker, ~25–30 ms of init on Lambda).
It is now a small Rust binary, the one deliberate exception to "TypeScript everywhere". Same
protocol and behaviour as before, so the tracer did not change beyond the non-blocking hello.

- **Design**: synchronous, no async runtime. It registers first thing, then binds the intake.
  `std::net` with a minimal HTTP/1.1 reader/writer (`src/http.rs`, Content-Length and chunked,
  one request per connection) serves the intake (a thread per connection) and talks to the
  Extensions API. The main thread runs the `/next` loop, the per-invocation wait (a `Condvar` in
  the span store), and the export.
- **Export**: `ureq` 2 (blocking, keep-alive pool) with `rustls`; gzip via `flate2` with the
  pure-Rust `miniz_oxide` backend; `serde_json` for the batches. The agent, and with it the TLS
  config, is created on the first export, so none of it runs during init. TLS roots come from
  `webpki-roots` (the Mozilla CA set compiled in) rather than the system store: it is the same
  set Node uses by default, it does not depend on what the runtime image ships, and nothing
  has to be read or parsed from disk.
- **Safety**: release builds use `panic = "abort"`, so the code avoids panicking paths (no
  `unwrap` outside tests, poisoned locks are recovered, stderr writes ignore errors, thread
  spawn failures are logged). Every error is logged and the loop continues; only a failed
  `register` (after 3 tries) exits. If the binary cannot start or bind its port, the tracer's
  hello fails and it exports directly, so the function still runs normally.
- **Packaging**: one zip for both architectures. `extensions/ivy-extension` is a POSIX `sh`
  launcher that `exec`s `/opt/ivy/bin/ivy-extension-arm64` or `-x86_64`. It reads `$HOSTTYPE`
  (bash is `/bin/sh` on Lambda's Amazon Linux images) and only falls back to forking `uname -m`
  elsewhere, and passes `ivy-extension` as the name to register. Measured cost: ~0.4 ms per
  start over exec'ing the binary directly (0.9 ms with `uname`). Two per-architecture layers would
  save that but double what auto-trace publishes and attaches, so the launcher stays.
- **Build**: static musl binaries (`x86_64-` and `aarch64-unknown-linux-musl`) with
  `opt-level = "s"`, LTO, one codegen unit, `panic = "abort"`, stripped: 1.8 MB (x86_64) and
  1.5 MB (arm64); `layer.zip` is 1.9 MB. ring (via rustls) has C and assembly, so
  cross-compiling needs a C toolchain per target: `cargo zigbuild` uses zig for both.
  `scripts/build.mjs` uses a local `cargo zigbuild` if installed, otherwise
  `extension/Dockerfile` (rust slim + zig and cargo-zigbuild from PyPI), or prebuilt binaries
  from `IVY_EXTENSION_BIN_DIR`. `packages/api/Dockerfile` has the same stage on `$BUILDPLATFORM`
  (dependencies compiled in their own layer for caching) and hands the binaries to the layer build.
- **Tests**: `cargo test` in `extension/` (span store, queue, backoff, dropped count, HTTP
  parsing, exporter against a local server, telemetry events: init failure, out of memory after
  partial spans, timeout, report enrichment, no duplicates); CI runs them in the `extension` job.

## Delivery

- OTLP/HTTP JSON to `<IVY_ENDPOINT>/v1/traces`, `Authorization: Bearer <IVY_API_KEY>`, gzip for
  bodies over 1 KB, keep-alive connections. The extension does this in Rust; the tracer's direct
  fallback (`src/lib/export/*`) implements the same rules in TypeScript.
- Per flush: up to 3 attempts (timeout `IVY_EXPORT_TIMEOUT_MS`, backoff 100/300 ms) within
  `IVY_FLUSH_BUDGET_MS` (2 s). Retries on network errors, 408, 429, 5xx, except that a 429 or 503 with
  `Retry-After` (e.g. a workspace over its monthly trace quota, `limits.md`) ends the flush at once: the batch is
  dropped and counted, and nothing is sent until the delay has passed (capped at 1 hour), not even the forced flush
  on `SHUTDOWN`.
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

- **AWS SDK v3**: `Module._load` is hooked (one shared hook, `require-hook.ts`); when any copy of `@smithy/core/client` (current
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
  ESM named imports); https only once something loads it (see "Tracer init"). The wrappers keep
  a reference to the original, which the layer's own transport uses. Bodies are captured by wrapping `write`/`end` and the response's `emit`,
  so stream flow mode and error-listener semantics are untouched.
- **fetch**: `globalThis.fetch` is wrapped; response bodies are read from `res.clone()` when the
  content type is text-like and the length is ≤ 1 MB.
- **console**: `log/info/warn/error/debug/trace` become `log` events on the root span.
- **OpenTelemetry API** (Vercel AI SDK and other libraries): a minimal global tracer provider and
  `AsyncLocalStorage` context manager turn library spans into children of the invocation. See `llm-spans.md`.
- Calls to the runtime API, the extension port and the Ivy endpoint (host + port) are skipped.

## Tracer init

What `handler.mjs` costs at init was measured phase by phase in the Lambda Node.js 22 image
(timing marks plus `process.moduleLoadList`). Before trimming it added ~35 ms to a trivial ESM
function, almost all of it module loading rather than our own code:

- **Static ESM imports of builtins (~20 ms).** An ESM `import … from 'node:http'` builds the
  module namespace from all exports, which runs lazy getters: `node:http`'s pulls in undici, tls
  and worker_threads (~23 ms on its own; `node:crypto` ~3.5 ms, `node:util` ~3.5 ms, `node:fs`
  ~3 ms). All builtins are now taken from `process.getBuiltinModule()` (Node ≥ 20.16) at first
  use, which returns the CommonJS object without building a namespace. Nothing in the bundle
  imports a builtin statically.
- **`node:https`, `node:zlib` (~4 ms).** The runtime already loads `node:http`, but not https
  (tls) or zlib. https is patched only once something loads it: the shared `Module._load` hook
  (`require-hook.ts`, also used for the AWS SDK) catches CommonJS requires, and a check after the
  user handler is loaded and at the start of each invocation catches ESM imports. The export
  transport loads https and zlib on first use, after a response.
- **Hello (~3 ms).** Now a raw `node:net` socket (the first `http.request` in a process costs a
  few ms), written before it connects, and init does not wait for it (see above).
- What is left: ~1 ms for the exec wrapper (one extra bash process, measured with `/opt/ivy-wrapper /bin/true`),
  ~1 ms to parse and run the 32 KB bundle (all first-party code; the metafile shows nothing
  worth splitting), ~0.5 ms to install the instrumentation.
- **Compile cache**: a pre-built `NODE_COMPILE_CACHE` shipped in the layer made no measurable
  difference to importing `handler.mjs` (15 runs each, within noise), and it would mean setting
  `NODE_COMPILE_CACHE` for the user's whole process (their modules and child processes too) with
  a read-only directory. Not shipped.

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

`handler.mjs` 32 KB, extension binaries 1.8 MB (x86_64) / 1.5 MB (arm64), `layer.zip` 1.9 MB.

Measured on Lambda (eu-west-1, Node.js 22, method and full tables in
[`layer-performance.md`](layer-performance.md)):

- Cold start: **+20–45 ms** init duration (p50, all of arm64/x86_64 × 128/1024 MB), down from
  +160–215 ms with the Node extension and untrimmed tracer.
- Warm response latency: no measurable difference at 1024 MB, ~1 ms at the median at 128 MB.
- Billed duration: +15–20 ms per warm invocation at 1024 MB for the export after the response
  (mostly the collector round trip), 40–50 ms at 128 MB.

Website-facing numbers: the old claim "under 1 ms added to a warm invocation" is only true for
response latency. Use "no measurable delay to warm responses; about 20–45 ms added to cold
starts", and do not imply billed duration is unchanged.

## Known gaps

- No trace context propagation (incoming `traceparent`/X-Ray headers, outgoing injection).
- Undici used directly (`require('undici')`) and the SDK's `undici-http-handler` are not traced.
- Response streaming handlers and Lambda multi-concurrency (`AWS_LAMBDA_MAX_CONCURRENCY`) are
  not traced (the tracer assumes one invocation at a time).
- In the RIE the client response waits for extensions, so e2e round-trip latency includes the
  export; on Lambda it does not.
- At 128 MB the post-response export takes 40–60 ms of a small CPU share; back-to-back
  invocations can queue behind it (see the p90 numbers in `layer-performance.md`).
- The exec wrapper is a bash script (~1 ms per cold start); a compiled wrapper would save most of it.
