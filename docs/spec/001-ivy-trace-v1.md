# Ivy Trace v1: development plan

**What:** Open-source observability for AWS Lambda (Node.js first). One container you can self-host on a single box, plus a multi-tenant hosted version at ivytrace.dev running the same stack. Successor to `includable/trace-stack`: reuse its Lambda layer and auto-instrumentation ideas, and replace its DynamoDB + SQS storage.

**v1 goal:** a handful of real production Lambda workloads are fully traced in Ivy and debugged through its UI and MCP server.

## Fixed decisions
- TypeScript everywhere, pnpm monorepo.
- Cloud-agnostic core. No AWS services in the backend. The only optional dependency is S3-compatible storage for ClickHouse tiered storage and backups.
- `docker compose up` runs everything: **OpenTelemetry Collector (contrib)** with a persistent on-disk queue (`file_storage`) → **ClickHouse** → **API (Hono)** → **UI (React)**. Hosted and self-hosted run the same images.
- Ingest accepts standard OTLP. The Ivy layer is just a convenient producer.
- Trace IDs start with a timestamp (as X-Ray IDs do) so lookups can prune by time.
- Multi-tenancy uses shared tables with `tenant_id` first in every `ORDER BY`. Self-hosted runs as a single tenant.

## Repo layout
```
packages/layer      Lambda layer + extension (Node.js auto-instrumentation)
packages/api        Hono API (only component that talks to ClickHouse; also attaches the layer via connected AWS accounts)
packages/ui         React dashboard
packages/mcp        Remote MCP server (on top of the API)
packages/cli        `ivytrace` CLI (on top of the API)
packages/format     Compact LLM-friendly trace renderer (shared by MCP + CLI)
deploy/             docker-compose, collector config, ClickHouse schema + migrations
tools/loadgen       Synthetic span generator for benchmarks
```

## Milestones

**M1. Ingest path**
- Layer captures the invocation (event, response, errors, cold start) and outgoing calls (AWS SDK, fetch/http) with payloads. Payloads are size-capped, and fields are redacted by config.
- The extension sends spans after the response is returned. If the backend can't be reached, it retries briefly, then drops the spans and reports a dropped count. It must never block or crash the function.
- Done when: a sample Lambda's traces appear in ClickHouse within 10s of the invocation.

**M2. Storage**
- `spans` table plus an `invocations` table (one row per invocation, with searchable fields pulled out: function, status, duration, error message, request ID, HTTP path).
- `TTL ts + toIntervalDay(retention_days)`, materialized views for hourly rollups, bloom-filter indexes on trace ID and common search fields.

**M3. API + UI**
- Views: function overview, invocation list (filters: function, status, time), trace timeline with payloads, error groups (by fingerprint), and search on the pulled-out fields.
- Start from the existing `includable/trace-stack` front-end rather than from scratch. It's a good base: modernize it and convert it from its own trace model to OpenTelemetry spans. Keep its service-specific rendering of AWS calls (DynamoDB, SQS, S3, etc.), which is a core feature. Map it onto OTel attributes (`rpc.system=aws-api`, `rpc.service`, `aws.dynamodb.table_names`, …), and make the layer emit those attributes.
- Auth: hosted uses Includable Auth. Self-hosted can configure any OIDC provider. Without OIDC configured, the dashboard, API and MCP run without auth (for setups behind an authenticating proxy), and the UI shows a persistent "authentication disabled" banner. Ingest always requires an API key.

**M4. Connect AWS accounts from the dashboard**
- A "Connect AWS account" button in the UI opens a CloudFormation quick-create link. That stack creates a cross-account IAM role (with an external ID) and an EventBridge rule for new functions. The same pattern Lumigo and Datadog use.
- Ivy assumes that role to attach the layer to all Node.js functions (and to newly created ones), sets the endpoint + API key, and lets users opt out per function from the UI.
- Works the same for hosted and self-hosted, since the box only needs to reach the AWS API, not run inside AWS.
- Done when: connecting an account and seeing its first traces takes under 5 minutes, without a terminal.

**M5. AI-native**
- `packages/format`: render a trace as a compact text tree (timings, errors, trimmed payloads).
- MCP tools: `find_failing_invocations`, `get_trace_summary`, `compare_invocations`, `list_error_groups`, `search_invocations`. Remote MCP with OAuth.
- CLI that mirrors the MCP tools, e.g. `ivytrace errors --fn checkout --since 1h`.

**M6. Hosted mode**
- Tenants, API keys, monthly span quotas enforced at ingest, per-query limits (`max_execution_time`, `max_memory_usage`), row policies as a second safety layer.

## Performance targets
Use `tools/loadgen` at 300k invocations/day × 45 spans, with 30 days of data, on one 2 vCPU / 8 GB box:
- invocation list < 500 ms
- open a trace < 300 ms
- 7-day dashboard < 1 s
- ingest lag < 10 s

## Not in v1
AI root-cause summaries, replay, LLM-call instrumentation, alerting beyond a webhook on new error groups, runtimes other than Node.js, high availability.
