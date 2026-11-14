# @ivy/layer

Lambda layer that traces Node.js functions without code changes and ships the spans
to an Ivy collector (or any OTLP/HTTP endpoint). Design notes live in
[`docs/implementation/layer.md`](../../docs/implementation/layer.md); the span format in
[`docs/implementation/span-conventions.md`](../../docs/implementation/span-conventions.md).

Runtimes: tested on `nodejs22.x`; `nodejs20.x` should work (needs Node ≥ 20.16 for
`process.getBuiltinModule`). One zip for x86_64 and arm64: the tracer is JS, and the extension
ships as a static binary per architecture behind a small launcher.

## Build

```sh
pnpm --filter @ivy/layer build      # -> packages/layer/dist/layer.zip
pnpm --filter @ivy/layer test       # unit tests (vitest)
pnpm --filter @ivy/layer test:extension  # extension unit tests (cargo)
pnpm --filter @ivy/layer e2e        # local end-to-end test in Docker (see below)
```

The extension is Rust (`extension/`). The build uses `cargo zigbuild` if it is installed
(`cargo install cargo-zigbuild`, zig, and the `x86_64-unknown-linux-musl` /
`aarch64-unknown-linux-musl` targets), otherwise Docker (`extension/Dockerfile`). With
`IVY_EXTENSION_BIN_DIR=<dir>` it takes prebuilt `ivy-extension-x86_64` / `ivy-extension-arm64`
from that directory instead.

Layer contents (mounted at `/opt`):

```
ivy-wrapper                     exec wrapper (AWS_LAMBDA_EXEC_WRAPPER)
nodejs/ivy/handler.mjs          in-process tracer + handler wrapper
extensions/ivy-extension        launcher: execs the binary for this architecture
ivy/bin/ivy-extension-<arch>    Lambda extension that exports spans after the response
```

## Publish

With a connected AWS account (Settings → AWS accounts) Ivy publishes and attaches the layer itself; see
[`docs/implementation/auto-trace.md`](../../docs/implementation/auto-trace.md). The steps below are for doing it by hand.

```sh
aws lambda publish-layer-version \
  --layer-name ivy-trace-nodejs \
  --description "Ivy Node.js layer" \
  --zip-file fileb://packages/layer/dist/layer.zip \
  --compatible-runtimes nodejs20.x nodejs22.x \
  --compatible-architectures x86_64 arm64 \
  --region eu-west-1
```

To share it with other accounts:

```sh
aws lambda add-layer-version-permission \
  --layer-name ivy-trace-nodejs --version-number 1 \
  --statement-id org --action lambda:GetLayerVersion \
  --principal '*' --organization-id o-xxxxxxxxxx
```

## Attach to a function

```sh
aws lambda update-function-configuration \
  --function-name my-function \
  --layers arn:aws:lambda:eu-west-1:123456789012:layer:ivy-trace-nodejs:1 \
  --environment 'Variables={AWS_LAMBDA_EXEC_WRAPPER=/opt/ivy-wrapper,IVY_ENDPOINT=https://ingest.example.com,IVY_API_KEY=your-key}'
```

Note that `--environment` replaces all variables; include the function's existing ones.

No code changes needed. Without `IVY_ENDPOINT` the wrapper leaves the handler alone and the
extension idles.

## Environment variables

| variable | default | |
|---|---|---|
| `AWS_LAMBDA_EXEC_WRAPPER` | | set to `/opt/ivy-wrapper` to enable |
| `IVY_ENDPOINT` | | collector base URL; spans go to `<endpoint>/v1/traces` |
| `IVY_API_KEY` | | sent as `Authorization: Bearer <key>` |
| `IVY_DISABLE` | `false` | turn tracing off without detaching the layer |
| `IVY_MAX_PAYLOAD_BYTES` | `16384` | cap for each `ivy.payload.*` attribute |
| `IVY_REDACT_KEYS` | see span conventions | comma-separated; a key is redacted if it contains one of these (case-insensitive, `-`/`_` ignored) |
| `IVY_CAPTURE_LOGS` | `true` | record `console.*` calls as span events |
| `IVY_CAPTURE_OTEL` | `true` | capture spans that libraries create through `@opentelemetry/api` (Vercel AI SDK, …) |
| `IVY_TIMEOUT_MARGIN_MS` | `100` | how long before the deadline to snapshot spans for a possible timeout |
| `IVY_EXPORT_TIMEOUT_MS` | `1000` | per-request export timeout |
| `IVY_FLUSH_BUDGET_MS` | `2000` | max time the extension spends exporting after each invocation |
| `IVY_MAX_QUEUE_SPANS` | `2000` | spans buffered while the endpoint is unreachable |
| `IVY_EXTENSION_PORT` | `9790` | localhost port between the function and the extension |
| `IVY_DEBUG` | `false` | log layer diagnostics |

## LLM calls (Vercel AI SDK)

Spans the AI SDK emits through OpenTelemetry show up as children of the invocation, with prompts,
responses, tool calls, tokens and time to first token. No OpenTelemetry SDK is needed:

- AI SDK 3–6: pass `experimental_telemetry: { isEnabled: true }` to `generateText`, `streamText`, …
- AI SDK 7: `registerTelemetry(new OpenTelemetry())` from `ai` and `@ai-sdk/otel`, once at the top of the handler module.

Other libraries that use `@opentelemetry/api` (OpenAI, Anthropic, LangChain instrumentations) are captured the
same way. If the app registers its own tracer provider, the layer leaves it alone. Details:
`docs/implementation/llm-spans.md`.

## Local end-to-end test

Needs Docker, no AWS account. It builds the layer, mounts it at `/opt` in the official
`public.ecr.aws/lambda/nodejs:22` image (Runtime Interface Emulator, real exec wrapper and
extension), runs the handlers in [`example/`](example) (CJS, callback-style and ESM; each does
`fetch`, `node:http` and a DynamoDB call against a fake endpoint), and invokes them with API
Gateway, SQS, scheduled, error and timeout events.

```sh
pnpm --filter @ivy/layer e2e
```

By default spans go to a capture server on the host (`:4399`) and the script asserts on them.
To send them to the local ingest router instead (`docker compose up` from the repo root first):

```sh
IVY_ENDPOINT=http://host.docker.internal:4318 IVY_API_KEY=dev-ingest-key pnpm --filter @ivy/layer e2e
```

Other knobs: `IVY_E2E_LOGS=1` prints container logs, `IVY_E2E_DUMP=1` prints the received
OTLP payloads, `IVY_E2E_CAPTURE_PORT` changes the capture port (the fake upstreams use the
port below it). To watch raw exports from your own tests, run `node scripts/capture-server.mjs`.
