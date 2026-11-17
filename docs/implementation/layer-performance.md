# Layer performance on Lambda

What the layer costs on real Lambda, before and after replacing the Node extension with the
Rust one (`docs/implementation/layer.md`, "Extension in Rust") and trimming the tracer's init
("Tracer init"). Measured in eu-west-1 in November 2026, Node.js 22 runtime.

## Method

- **Functions**: one trivial handler (`fetch` to a fast in-region HTTPS URL, return a small
  object), 4 variants × 2 architectures (arm64, x86_64) × 2 memory sizes (128 MB, 1024 MB):
  - **no layer**: the baseline;
  - **Node extension (main)**: the layer as built from main before this work (Node extension, old tracer);
  - **Rust extension**: the old tracer with the Rust extension;
  - **Rust + trimmed tracer**: the current layer.
- **Ingest endpoint**: a stand-in for Ivy's ingest, a second Lambda function behind a function URL that answers `200 {}` and logs the
  span count, so every export is a real HTTPS request (TLS handshake on the first export of each
  environment). The handler's `fetch` goes to another URL of that function (an alias), so it is
  traced as a normal outgoing call. All spans arrived with the right `Authorization` header.
- **Cold starts**: 40 per variant, forced by changing an environment variable between
  invocations; each cold invocation is followed by 3 warm ones. `Init Duration` comes from the
  `REPORT` lines in CloudWatch Logs.
- **Warm latency**: a driver function in the same region invoked the four variants of each
  architecture/memory group round-robin, 60 times each after 2 warm-ups, and timed each
  synchronous `Invoke`. Lambda returns the response before extensions finish, so this is what a
  caller sees; it includes ~25 ms of Invoke API overhead common to all variants.
- **Billed duration**: `REPORT` `Duration` of the same warm invocations. With an extension it also
  covers the time after the response until the extension calls `/next`, i.e. the export.
- Overhead = variant percentile − baseline percentile. With 40–60 samples, differences of a few
  ms are within noise.

All resources were named `ivy-bench-*`, tagged `project=ivy-bench`, and deleted afterwards.

## Cold start: init duration (ms)

| arch | memory | no layer p50 / p90 | Node ext. (main) overhead p50 / p90 | Rust ext. overhead p50 / p90 | Rust + trimmed overhead p50 / p90 |
|---|---|---|---|---|---|
| arm64 | 128 MB | 108 / 132 | +181 / +239 | +113 / +140 | **+32 / +36** |
| arm64 | 1024 MB | 125 / 138 | +161 / +228 | +100 / +142 | **+21 / +33** |
| x86_64 | 128 MB | 148 / 180 | +214 / +218 | +133 / +134 | **+39 / +34** |
| x86_64 | 1024 MB | 148 / 182 | +202 / +197 | +136 / +135 | **+43 / +39** |

On Lambda the old layer cost far more than the 40–50 ms seen in Docker on a Mac: ~160–215 ms.
The Rust extension removes ~65–80 ms of that and the trimmed tracer another ~80–95 ms, leaving
**+20–45 ms**. What is left is the exec wrapper (one extra bash process), loading the 32 KB
tracer bundle, starting the extension and Lambda's own extension handshake. Init runs at full
CPU, which is why 128 MB and 1024 MB look alike.

## Warm invocations

Client-observed latency (what a caller waits for), ms:

| arch | memory | no layer p50 / p90 | Node ext. overhead p50 / p90 | Rust ext. overhead p50 / p90 | Rust + trimmed overhead p50 / p90 |
|---|---|---|---|---|---|
| arm64 | 128 MB | 28 / 50 | +23 / +169 | +3 / +119 | **+1 / +54** |
| arm64 | 1024 MB | 29 / 39 | +1 / −2 | +4 / +1 | **+2 / 0** |
| x86_64 | 128 MB | 30 / 50 | +13 / +106 | 0 / +44 | **+1 / +24** |
| x86_64 | 1024 MB | 31 / 38 | +1 / +1 | −2 / −2 | **0 / +1** |

Billed duration (`REPORT` `Duration`, includes the post-response export), ms:

| arch | memory | no layer p50 / p90 | Node ext. overhead p50 / p90 | Rust ext. overhead p50 / p90 | Rust + trimmed overhead p50 / p90 |
|---|---|---|---|---|---|
| arm64 | 128 MB | 19 / 121 | +98 / +459 | +59 / +297 | **+49 / +84** |
| arm64 | 1024 MB | 16 / 25 | +18 / +24 | +19 / +20 | **+18 / +20** |
| x86_64 | 128 MB | 24 / 136 | +73 / +265 | +38 / +44 | **+38 / +100** |
| x86_64 | 1024 MB | 18 / 22 | +17 / +20 | +15 / +19 | **+16 / +21** |

- At 1024 MB the response is not measurably slower with the layer (within ±2 ms, the noise
  floor of this method). At 128 MB the median is within ~1 ms; the p90 tail comes from
  back-to-back invocations that arrive while the previous invocation's export is still running
  on the environment's small CPU share, so Lambda queues them or starts a new environment.
- Billed duration grows by the export: ~15–20 ms at 1024 MB, most of it the HTTPS round trip to
  the ingest endpoint (here a Lambda function URL, itself ~10–15 ms). A faster ingest endpoint
  makes this smaller; the extension's language hardly matters for it at 1024 MB. At 128 MB
  serializing and exporting on a fraction of a vCPU costs 40–60 ms at the median, less with the
  Rust extension than with Node.

## Website claim

The website said "under 1 ms added to a warm invocation". Measured on Lambda:

- Response latency of a warm invocation: no measurable difference at 1024 MB, ~1 ms at the
  median at 128 MB. "About 1 ms or less added to a warm response" holds; "under 1 ms" in general
  does not at 128 MB p90.
- Billed duration: +15–20 ms per warm invocation at 1024 MB (the export after the response),
  more at 128 MB.
- Cold start: +20–45 ms init.

Suggested wording: "No measurable delay to warm responses; about 20–45 ms added to cold starts.
Spans are exported after the response, which adds the export round trip to billed duration."

## Local numbers (Docker, M-series Mac)

For comparison, the RIE in Docker with a trivial ESM handler (20 cold starts each, `INIT REPORT`):
no layer 32 ms; Node extension + old tracer +66 ms; Rust extension + old tracer +39 ms; Rust +
trimmed tracer +13 ms. Extension spawn-to-`register`: Node 47.5 ms, Rust binary 1.9 ms (of which
most is the spawn itself), through the `sh` launcher 2.2 ms.

## Worker threads

What tracing `worker_threads` adds (`layer.md`, "Worker threads"), measured in November 2026 in the Lambda
Node.js 22 image (Runtime Interface Emulator, Docker arm64 on an M-series Mac, so absolute times are not Lambda's;
not yet measured on Lambda). Three variants of the same function, invoked in turn: no layer, the layer with
`IVY_CAPTURE_WORKERS=false`, and the layer tracing workers.

A small queue consumer (`example/workers`): one job per invocation in a worker thread that loads the handler file,
does one `fetch` and one DynamoDB call against a fake endpoint, and exits; 60 invocations per variant, ms:

| p50 / p90 | no layer | layer, workers off | layer, workers traced |
|---|---|---|---|
| `new Worker()` → first line of the worker's code | 105.8 / 127.8 | 109.5 / 145.7 | 117.2 / 155.3 |
| the job inside the worker | 58.7 / 80.9 | 62.4 / 76.8 | 64.4 / 101.9 |
| worker's last line → handler sees `exit` | 2.7 / 8.4 | 2.2 / 8.4 | 4.0 / 10.1 |
| total | 171.9 / 206.1 | 180.9 / 247.9 | 187.9 / 243.4 |

Tracing workers adds ~7–8 ms to the start of each worker (the bootstrap, see `layer.md`), ~2 ms to the job (first
use of the instrumentation in a fresh isolate, posting spans) and ~2 ms at exit, at the median; p90 differences are
within noise at this sample size. Before trimming the bootstrap (lazy http/crypto/perf_hooks, parentPort instead of
a BroadcastChannel) it was ~16 ms per worker start on the same machine.

A real app's job runner (a 9.5 MB ESM bundle loaded by both the handler and the worker, job lookup against a fake
DynamoDB endpoint, `process.exit(1)` from the worker; runtime duration from the emulator's `REPORT`, 39 invocations
per variant): no layer 1017 / 1419 ms, layer with workers off 1080 / 1180 ms, workers traced 1059 / 1248 ms (p50 /
p90). On a job of about a second the worker overhead is below the noise.

## Reproducing

The scripts were throwaway (create role, sink function with two URLs, three layer versions,
16 functions; force cold starts via `update-function-configuration`; read `REPORT` lines with
`filter-log-events`; a driver function for warm latency). Keep the Lambda control plane load low
when the account runs production systems: the run used at most 4 functions at a time.
