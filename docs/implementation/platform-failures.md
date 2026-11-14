# Platform failures and throttles

Some Lambda failures happen outside the handler wrapper, so the in-process tracer never sees them or dies
before it can report them:

| failure | why the tracer misses it |
|---|---|
| init errors: `Runtime.ImportModuleError`, `Runtime.HandlerNotFound`, `Runtime.UserCodeSyntaxError`, a throw at module load | the user module never finishes loading, so there is no wrapped handler |
| out of memory (`Runtime.OutOfMemory`), crashes (`Runtime.ExitError`) | the process dies; spans still in memory are lost |
| timeouts (`Sandbox.Timedout`) | only covered by the tracer's provisional snapshot, which can come too late |
| throttles | the request never reaches the function |

Ivy covers the first three in the Rust extension with the Lambda **Telemetry API**, and throttles in the API's
auto-trace loop with **CloudWatch metrics**. The guiding constraint is the margin: a trace is one invocation and is
billed at €2 per million, so a healthy invocation must not get extra spans, and function logs are never shipped
wholesale. Data is added only on failure, plus a few attributes on the existing invocation span.

## Extension: Telemetry API

Code: `packages/layer/extension/src/platform.rs` (event handling, log tail, error description, redaction),
`spans.rs` (synthetic roots, update spans), `store.rs` (`finish`, `wait_for`), `main.rs` (listener, subscription).

### Subscription

Right after `register`, the extension binds a second listener on `0.0.0.0:9791` (`IVY_TELEMETRY_PORT`; Lambda
delivers to `http://sandbox.localdomain:<port>/`, which is not loopback) and subscribes with
`PUT /2022-07-01/telemetry`:

- `schemaVersion: "2025-01-29"` (the current version; backward compatible, and the only one Lambda Managed
  Instances accept),
- `types: ["platform", "function"]`: platform events plus function logs, no extension logs (so the extension's own
  stderr can't loop back),
- `buffering: { maxItems: 1000, maxBytes: 262144, timeoutMs: 25 }`, the smallest values Lambda accepts, so events
  arrive within ~25 ms of being emitted and Lambda holds at most 256 KB for us.

`register` also sends `Lambda-Extension-Accept-Feature: accountId`, so synthetic spans carry `cloud.account.id`.
If the subscription fails (the Runtime Interface Emulator doesn't implement the Telemetry API) the extension logs it
with `IVY_DEBUG` and behaves exactly as before. `IVY_PLATFORM_TELEMETRY=false` turns the whole path off.

### Function logs: a tail, never exported

Function log events go into an in-memory ring of the last **50 lines / 8 KB** (2 KB per line). Text records
(`<time>\t<request id>\t<LEVEL>\t<message>`, Node's format) and JSON records (`{level, message}`) are both parsed
into a severity and a message. The ring is cleared when `platform.runtimeDone` (or `platform.initRuntimeDone`)
reports success, so a healthy invocation exports none of it. On a failure the tail is moved into the failure and
then cleared. Redaction (`IVY_REDACT_KEYS`, same key matching as the tracer: lowercased, `-`/`_` removed, substring)
is applied to `"key": value` and `key=value` pairs when the lines are turned into span events, not on the hot path.

### Events used

| event | what happens |
|---|---|
| `platform.initStart` | remembers the init start (start time of an init-failure span) |
| `platform.initRuntimeDone` `success` | clears the log tail |
| `platform.initRuntimeDone` `error`/`failure` | records an init failure with the log tail; the tracer is no longer waited for |
| `platform.initReport` | init duration (and error type if `initRuntimeDone` had none) |
| `platform.restoreReport` | SnapStart restore duration |
| `platform.start` | invocation start time (start of a synthetic span) |
| `platform.runtimeDone` `success` | clears the log tail; ends the wait for a tracer that never sends its final batch (after 100 ms) |
| `platform.runtimeDone` `error`/`failure`/`timeout` | records the failure with the log tail and ends the wait for the tracer at once (`error`: after 50 ms, since the tracer normally reports a handler error itself) |
| `platform.report` | billed duration, max memory used, memory size, init/restore duration for that request |
| `function` | log tail |

### What is exported

**Init failure.** A synthetic invocation root (`ivy.invocation=true`, `ivy.synthetic=true`) named after the function,
status `ERROR`, `error.type` from the platform (falling back to the `errorType` the runtime logged, then
`Runtime.InitError`), `ivy.failure.phase=init`, `ivy.platform.status`, `ivy.init_duration_ms`, `faas.coldstart=true`,
the log tail as `log` events, start = `initStart`, end = `initRuntimeDone`. The resource is the tracer's if it sent one,
otherwise one built from the environment (`service.name`, `faas.name`, region, version, memory, account ID).

Request IDs at init: init runs before any request, so the span is created without `faas.invocation_id`. When does
it get one?

- Lambda resets the environment after a failed init. The extension exports the failure at the next lifecycle event
  it receives: `SHUTDOWN` (no request ID) or, if Lambda sends an `INVOKE` first, that invocation's request ID.
- When Lambda retries the init as part of the next invocation (a "suppressed init", `phase: invoke`), the new
  extension process sees the failed init and then the `INVOKE`, so the span carries that request's ID. A
  `runtimeDone` failure for the same request is not turned into a second invocation.
- Every failed attempt is one invocation span, so a function that can't load shows one failure per attempt, which
  matches what the caller saw.

**Crash or timeout during an invocation** (`runtimeDone` with `failure`, `error` or `timeout`):

- If the tracer delivered its final batch and the root already has an error, nothing changes (a handler error the
  tracer reported, possibly with `runtimeDone: error`).
- If the tracer's root is there but unfinished (the provisional timeout snapshot, or spans from before the crash),
  that root is completed: error status, `error.type` (`Runtime.OutOfMemory`, `Runtime.ExitError`,
  `Sandbox.Timedout`), `ivy.failure.phase=invoke`, `ivy.platform.status`, end time = `runtimeDone`, plus the log tail.
  Children are kept. The tracer's `error.type = "Timeout"` becomes `Sandbox.Timedout`.
- If there is no root at all (crash before the tracer's first batch, which is the normal case since the tracer only
  sends at the end), a synthetic root is created with the same attributes and the request ID.

The span keeps one span ID per invocation in every case, so there is never a duplicate invocation.

**Status message.** The error group fingerprint is `function + error.type + normalized message`
(`storage.md`), so the message is chosen to be the most telling single line: the `errorMessage` of a JSON error the
runtime logged (`Error: Cannot find module 'left-pad'` for an ImportModuleError), else a `FATAL ERROR` line (V8's
heap limit message), else the last error-level line, else a fixed text per type (`Task timed out`, `Runtime exited:
out of memory`, …). Capped at 300 bytes and redacted.

**Cold-start attributes.** The first invocation of an environment gets `ivy.init_duration_ms` (and
`ivy.restore_duration_ms` for SnapStart) from `platform.initReport`/`restoreReport`, which arrive before the first
`INVOKE`. No extra span.

**Report metrics** (`ivy.billed_duration_ms`, `ivy.memory_max_used_mb`, `ivy.memory_size_mb`). Lambda emits
`platform.report` when the invoke phase ends, and the invoke phase only ends once every extension has called
`/next` (billed duration includes the extension's own time). So the report for an invocation can never arrive
inside that invocation's post-response window, no matter how long the extension waits. Waiting would only add
billed time. Instead:

- Each export remembers the last 8 exported roots (trace ID, span ID, name, start/end, resource).
- When a report arrives for one of them, the next export (the next invocation's, or the one at `SHUTDOWN`) carries an
  **update span**: the root's trace ID, span ID, name and times, with only `ivy.update=true`,
  `faas.invocation_id` and the report attributes. It is not an invocation (`ivy.invocation` is absent), so it is
  neither counted nor billed; the backend merges its attributes into the root by span ID when a trace is read.
- If the root is still in the store when its report arrives (a failure exported at `SHUTDOWN`), the attributes go
  onto the root directly.
- At `SHUTDOWN` the extension waits up to 150 ms for telemetry still in Lambda's buffer (the init outcome, the last
  invocation's outcome and pending reports), then flushes. The shutdown phase is not billed.
- `IVY_REPORT_METRICS=false` turns update spans off.
- Projects: update spans and synthetic roots go out with the function's ingest key like every other span, so the
  router stamps the same project on them (`workspaces-projects.md`). The project-scoped trace route merges an update
  into its root as before; the ingest usage counter counts only `ivy.invocation` spans, so an update is never a trace.

### Waiting and billed time

Nothing waits for telemetry on a healthy invocation: the extension still waits for the tracer's final batch (as
before) and exports right away. `runtimeDone` only shortens waits that would otherwise run to the deadline: a crash
or timeout ends the wait at once instead of at `deadline + 200 ms`, and a tracer that never sends its final batch is
given up 100 ms after a successful `runtimeDone`. Without the exec wrapper (no tracer) the extension never waits;
crashes are then exported at the next event (`SHUTDOWN` after the reset).

## Costs

### Ivy (bytes per invocation)

- Healthy warm invocation: nothing is added to the invocation span. One update span with the report metrics follows
  in the next export: ~520–570 bytes of OTLP JSON (mostly the trace, span and request IDs), **~125 bytes on the wire**
  once gzipped with the batch it travels in (a typical HTTP invocation batch is ~475 bytes gzipped, so ~+26 %).
  It is not an invocation, so it is never billed as a trace. `IVY_REPORT_METRICS=false` removes it.
- Cold start: `+ ivy.init_duration_ms` on the first root (~70 bytes).
- Failures only: the synthetic or completed root plus up to 8 KB of log tail (≤ 50 `log` events), typically 1–3 KB
  gzipped.
- In ClickHouse the update span is one extra `otel_traces` row per invocation and no `invocations` row.

### Extension (cold start and warm)

- Cold start: binding the telemetry listener, spawning its thread and one `PUT` to the local Runtime API. It runs
  after `register`, in parallel with the runtime's own init (which the init phase waits for anyway), so it delays
  nothing the caller sees. Measured: the subscription round trip (bind + PUT) takes 0.2–0.6 ms against the
  emulator's Runtime API (`IVY_DEBUG` logs it); spawn → first `/next` of the extension was 6.5 ms without and 7.2 ms
  with telemetry (median of 40 interleaved runs each in the Lambda image, `fake-telemetry.mjs --coldstart`), within
  the noise of a laptop running Docker.
- Warm: parsing the telemetry batches (`platform.start`, `runtimeDone`, `report`, log lines) and the extra
  bookkeeping in `finish`: ~16 µs per invocation in a release build
  (`cargo test --release -- --ignored --nocapture bench_warm_invocation_overhead`), plus one short-lived thread per
  telemetry delivery. Most deliveries land after the response; none of it delays the response.

### Customer (CloudWatch)

`GetMetricData` is billed to the customer's AWS account at $0.01 per 1,000 metrics requested (us-east-1 list price;
never covered by the free tier):

| case | metrics requested | cost |
|---|---|---|
| account-level poll, per region with traced functions | 12/hour × 24 × 30 = 8,640 per month | ≈ $0.09 per region per month |
| 3 regions | 25,920 per month | ≈ $0.26 per month |
| follow-up after a poll that saw throttles | 1 per traced function in the region | 100 functions: $0.001 per throttled poll |
| worst case: 100 traced functions, throttled in every poll | +864,000 per month | +$8.64 per month |

The poll can be switched off per account (Settings → AWS accounts → "Throttle metrics").

## Throttles

Throttled requests never reach the function, so no extension can see them. The API's auto-trace sync loop reads
them from CloudWatch through the existing cross-account role (`auto-trace.md`, "Throttles", has the details):

- every 5 minutes, per connected account and region, `GetMetricData` for the account-level `AWS/Lambda`
  `Throttles` (Sum, 1-minute period);
- only when that is non-zero, per-function `Throttles` for the affected window, for the functions Ivy traces;
- stored as per-function, per-minute counts in a small ClickHouse table, keyed by tenant and project (the project the
  function is traced into; throttles of untraced or unassigned functions are dropped), with the same retention;
- shown as a count on the function overview, a series in the function's chart, and a synthetic "Throttled" error
  group (no trace; it links to the function). MCP `list_error_groups` includes it.

The role needs `cloudwatch:GetMetricData` (added to the template). Connections whose stack predates it keep working;
the account page asks to update the stack. The poll is a per-account setting, on by default, and it is billed to the
customer's AWS account.

## Verification

- `cargo test` in `packages/layer/extension`: init failure (synthetic root, log tail, redaction, no request ID),
  init failure followed by an `INVOKE` (request ID, no duplicate), out of memory after partial spans (root completed,
  child kept, wait ends at once), crash without spans, timeout replacing the snapshot's error, a handler error kept as
  the tracer reported it, cold-start init duration, report as a later update span and in place, the shutdown wait,
  log tail bounds, text/JSON log parsing, timestamps.
- `pnpm --filter @ivy/layer e2e`: the emulator answers the subscription with `Telemetry.NotSupported`, so the e2e
  runs two failing handlers in the emulator (`example/failures/missing.js`, `oom.js` with a 32 MB heap) to check what
  callers see and to collect the log lines they really print, then runs `scripts/fake-telemetry.mjs` in the Lambda
  image: the real extension binary against a fake Extensions + Telemetry API that replays those lines with the
  platform events Lambda would send. It checks the init-failure span, the completed out-of-memory span, the
  update spans and that healthy invocations carry no logs. Not verified on Lambda itself.

## Limits

- In the emulator a V8 heap exhaustion surfaces as `Runtime.ExitError` (`signal: aborted`); Ivy reports it as
  `Runtime.OutOfMemory` when the log tail has V8's `JavaScript heap out of memory` line, so it is labelled "Out of
  memory" like Lambda's own memory-limit kill.
- Without the Telemetry API (the emulator, or `IVY_PLATFORM_TELEMETRY=false`) a crash leaves the extension waiting
  for the tracer until the deadline, as before.
- Out of memory: the extension shares the function's memory. If the kernel kills the extension too, or Lambda
  freezes the environment before the next event, the failure is lost.
- The log tail holds what Lambda delivered before the failure event. Lines Lambda dropped under pressure
  (`platform.logsDropped`) are missing, and a crash can cut the last lines short.
- Function logs are buffered only while subscribed: anything logged before the subscription took effect may be
  missing from an init failure's tail (in practice the runtime starts after `register`, and the subscription follows
  right after).
- A report that arrives more than 8 exported invocations late, or for an environment that is never invoked again and
  shut down without the report, is dropped. The update only reaches the trace view and the invocation detail; the
  `invocations` table keeps the values from the root.
- Lambda Managed Instances (concurrent invocations, no `INVOKE` events for extensions) are not handled.
