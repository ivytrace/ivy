# Ivy Trace

Open-source observability for AWS Lambda (Node.js first). One `docker compose up`
runs everything: OpenTelemetry Collector → ClickHouse → API (Hono) → UI (React).
Successor to `includable/trace-stack`.

**Status: early v1, under active development.**

## Layout

```
packages/layer      Lambda layer + extension (Node.js auto-instrumentation)
packages/api        Hono API (only component that talks to ClickHouse)
packages/ui         React dashboard
deploy/             docker-compose, collector config, ClickHouse schema
tools/loadgen       Synthetic span generator
docs/spec/           Specs (human-written)
docs/implementation/ Implementation decisions, span conventions, API contract
```

See `docs/implementation/span-conventions.md` and `docs/implementation/api.md`.
