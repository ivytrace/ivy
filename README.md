# Ivy Trace

Open-source observability for AWS Lambda (Node.js first). One `docker compose up`
runs everything: OpenTelemetry Collector → ClickHouse → API (Hono) → UI (React).
Successor to `includable/trace-stack`.

**Status: early v1, under active development.**

## Development

```sh
pnpm install
pnpm dev        # ClickHouse + collector in Docker, API + dashboard with hot reload
                # dashboard: http://localhost:5173, API: :3000, OTLP: :4318
pnpm --filter loadgen start -- --count 5000 --backfill 24   # sample data
pnpm dev:mock   # dashboard only, with fixture data (no Docker)
pnpm up         # full production-like stack in Docker (http://localhost:3000)
pnpm down       # stop containers (data is kept in volumes)
```

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
