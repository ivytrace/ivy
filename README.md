# Ivy

Open-source observability for AWS Lambda (Node.js first). One `docker compose up`
runs everything: OpenTelemetry Collector → ClickHouse → API (Hono) → UI (React).
Successor to `includable/trace-stack`.

**Status: early v1, under active development.**

## Development

```sh
pnpm install
pnpm dev        # ClickHouse + collector in Docker; API, ingest router and dashboard with hot reload
                # dashboard: http://localhost:5173, API: :3000, OTLP/HTTP: :4318 (key dev-ingest-key)
pnpm --filter loadgen start -- --count 5000 --backfill 24   # sample data
pnpm dev:mock   # dashboard only, with fixture data (no Docker)
pnpm up         # full production-like stack in Docker (http://localhost:3000)
pnpm down       # stop containers (data is kept in volumes)
```

## Layout

```
packages/layer      Lambda layer + extension (Node.js auto-instrumentation)
packages/api        Hono API and the OTLP ingest router (only components that talk to ClickHouse)
packages/ui         React dashboard
packages/spans      Span types and service-aware span descriptions (shared by UI and format)
packages/format     Traces and invocation lists as compact text for LLMs
packages/mcp        Remote MCP server (mounted at /mcp by the API)
deploy/             docker-compose, collector config, ClickHouse schema
tools/loadgen       Synthetic span generator
docs/spec/           Specs (human-written)
docs/implementation/ Implementation decisions, span conventions, API contract
```

## For agents

Ivy has no CLI; agents use MCP or the HTTP API:

```sh
claude mcp add --transport http ivy http://localhost:3000/mcp     # tools: find_failing_invocations, get_trace_summary, …
curl 'http://localhost:3000/api/traces/<trace id>?format=text'    # one trace as a compact text tree
open http://localhost:3000/api/docs                               # API reference (OpenAPI at /api/openapi.json)
```

With OIDC configured, `/mcp` is an OAuth protected resource (`docs/implementation/mcp.md`).

See `docs/implementation/span-conventions.md`, `docs/implementation/api.md`, `docs/implementation/mcp.md` and
`docs/implementation/tenancy.md` (tenants, API keys, ingest router, sharding plan).
