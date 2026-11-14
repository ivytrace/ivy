# API contract (v1)

Served by `packages/api` (Hono) on port `3000`. All JSON. Timestamps in responses are
ISO 8601 strings with millisecond precision (UTC). Durations are milliseconds (float).

The OpenAPI 3.1 version of this contract is served at `GET /api/openapi.json`, with a reference page at
`GET /api/docs` (both public). Agents can also use the MCP server at `/mcp` (see below and `mcp.md`).

Auth (`auth.md`): with OIDC configured (`IVY_OIDC_ISSUER`), every `/api/*` route except `GET /api/health`,
`GET /api/config`, `POST /api/aws/events`, `GET /api/openapi.json` and `GET /api/docs` needs `Authorization: Bearer <access token>` (a JWT from the configured
issuer, for `IVY_OIDC_AUDIENCE`, issued to the dashboard's client or one of its agents). Without it: 401
`{ "error": "Authentication required" }`; invalid or expired: 401 with `WWW-Authenticate: Bearer error="invalid_token"`;
provider unreachable: 503. Without OIDC configured nothing is checked.

Every `/api/*` route except `/api/health`, `/api/config` and `/api/aws/events` runs for one tenant, resolved by
middleware from the request: `default` with auth off or in single-tenant mode, otherwise the signed-in user's tenant
(`auth.md`, "Users and tenants"). Data is only ever read for that tenant. See `tenancy.md`.

Time range params, accepted by every list endpoint:
- `since=15m|1h|24h|7d` (default `24h`), or
- `from` / `to` as ISO strings (override `since`).

## `GET /api/health`
`{ "ok": true, "clickhouse": true }` (the control database and every shard answer a ping; 503 otherwise)

## `GET /api/config`
`{ "version": "0.1.0", "auth": { "enabled": false } }`, or with OIDC:
`{ "version": "0.1.0", "auth": { "enabled": true, "issuer": "https://auth.includable.com", "clientId": "ivy", "audience": "https://ivytrace.dev/api", "scopes": "openid email profile offline_access" } }`.
The UI configures sign-in from it at runtime, and shows the "authentication disabled" banner when `auth.enabled` is false. Public.

## `GET /api/functions`
Function overview for the range.
```json
{ "items": [ {
  "name": "checkout-createOrder", "region": "eu-west-1",
  "invocations": 1234, "errors": 12, "error_rate": 0.0097,
  "cold_starts": 40, "avg_ms": 120.5, "p50_ms": 80.1, "p95_ms": 410.0, "p99_ms": 900.2,
  "last_invoked": "2026-11-14T12:00:00.000Z"
} ] }
```

## `GET /api/invocations`
Query: `function`, `status` (`ok`|`error`), `q` (free text: matches request ID, trace ID, error message, HTTP path), `limit` (default 50, max 500), `cursor` (opaque; from `next_cursor`).
```json
{ "items": [ {
  "trace_id": "673f1a2b…", "span_id": "…", "ts": "…",
  "function": "checkout-createOrder", "region": "eu-west-1",
  "status": "ok", "duration_ms": 93.2, "cold_start": false,
  "request_id": "…", "trigger": "aws:apigatewayv2",
  "http_method": "POST", "http_path": "/orders", "http_status": 200,
  "error_type": null, "error_message": null, "memory_used_mb": 88
} ], "next_cursor": "…" | null }
```
Sorted by `ts` descending.

## `GET /api/traces/:traceId`
All spans of a trace, sorted by start time.
```json
{ "trace_id": "…", "spans": [ {
  "span_id": "…", "parent_span_id": "" ,
  "name": "DynamoDB.GetItem", "kind": "CLIENT", "service": "checkout-createOrder",
  "start": "…", "end": "…", "duration_ms": 12.3,
  "status_code": "OK" | "ERROR" | "UNSET", "status_message": "",
  "attributes": { "rpc.system": "aws-api", "…": "…" },
  "resource": { "service.name": "…", "cloud.region": "…" },
  "events": [ { "ts": "…", "name": "log", "attributes": { "log.severity": "info", "log.message": "…" } } ]
} ] }
```
Attribute values are strings in storage; the API returns them as stored (strings).
JSON-valued attributes (`ivy.payload.*`, headers, arrays) are JSON strings for the UI to parse.
404 if not found.

`?format=text` returns `text/plain` instead: the trace as a compact text tree for LLMs (`@ivy/format`, see `mcp.md`).
`detail=summary|normal|full` (default `normal`), `max_tokens` (default 4000, `0` = no limit). 400 for other values.

## `GET /api/errors`
Error groups, grouped by fingerprint (function + error type + normalized message).
Query: `function`.
```json
{ "items": [ {
  "fingerprint": "…", "function": "…", "error_type": "TypeError",
  "error_message": "Cannot read properties of undefined (reading 'id')",
  "count": 42, "first_seen": "…", "last_seen": "…", "sample_trace_id": "…"
} ] }
```

## `GET /api/stats/timeseries`
Query: `function` (optional), `bucket` (`1m`|`5m`|`15m`|`1h`|`1d`, default picked from range to keep about 100 points or fewer).
```json
{ "items": [ { "ts": "…", "invocations": 10, "errors": 1, "p95_ms": 300.1 } ] }
```

## AWS accounts (auto-trace)

Design and flow: `auto-trace.md`. Request bodies are JSON. Errors are `{ "error": "…" }` with 400/404/409.

### `GET /api/aws/setup`
Server-side configuration the connect flow needs.
```json
{ "principal_arn": "arn:aws:iam::999999999999:role/ivy" | null, "template_url": "https://…/ivy-trace.yaml" | null,
  "events_url": "https://ivy.example.com/api/aws/events" | null, "public_url": "…" | null,
  "ingest_endpoint": "https://ingest.example.com" | null, "layer_sha256": "…" | null,
  "default_region": "us-east-1", "regions": ["us-east-1", "…"], "sync_interval_seconds": 300,
  "issues": ["Set IVY_INGEST_PUBLIC_URL, plus IVY_SECRET_KEY (or IVY_INGEST_API_KEY for the default tenant), …"] }
```

### `GET /api/aws/template.yaml`
The CloudFormation template (`text/yaml`). `account=<id>` fills in that connection's parameters as defaults;
`download=1` adds `content-disposition: attachment`.

### `GET /api/aws/accounts`, `GET /api/aws/accounts/:id`
```json
{ "items": [ {
  "id": "7695fb70-…", "name": "Production", "account_id": "123456789012",
  "role_arn": "arn:aws:iam::123456789012:role/IvyTrace-7695fb70", "external_id": "ivy-…",
  "stack_name": "ivy-trace-7695fb70", "stack_region": "eu-west-1",
  "regions": ["eu-west-1"], "all_regions": false,
  "status": "pending" | "connected" | "error", "error": "…" | null,
  "created_at": "…", "verified_at": "…" | null, "last_sync_at": "…" | null, "syncing": false,
  "counts": { "traced": 12, "opted_out": 1, "unsupported": 3, "conflict": 1, "error": 0, "pending": 0, "total": 17 },
  "quick_create_url": "https://eu-west-1.console.aws.amazon.com/cloudformation/home?…" | null,
  "template_download_url": "/api/aws/template.yaml?account=…&download=1"
} ] }
```
`error` on a connected account lists per-region sync errors, one per line.

### `POST /api/aws/accounts`
Body: `{ "account_id": "123456789012", "name"?: "Production", "regions": ["eu-west-1"], "all_regions"?: false, "stack_region"?: "eu-west-1" }`.
The stack region is added to `regions`. 201 with the account (status `pending`). 409 if the AWS account is already connected.

### `PATCH /api/aws/accounts/:id`
Body: any of `name`, `regions`, `all_regions`. Starts a sync for connected accounts. Returns the account.

### `POST /api/aws/accounts/:id/verify`
Tries `AssumeRole`. `{ "verified": true|false, "account": {…} }`; on success the account becomes `connected` and the first sync starts.

### `POST /api/aws/accounts/:id/sync`
202 `{ "started": true }`; the sync runs in the background (`?wait=1` waits). 409 while pending.

### `DELETE /api/aws/accounts/:id?detach=true|false`
Removes the layer from all functions first unless `detach=false` (or the account is pending), then deletes the connection.
`{ "deleted": true, "detached": true, "detach_errors": ["eu-west-1/fn: …"] }`.

### `GET /api/aws/functions?account=<12-digit id>`
Tracing state of every function in the connected accounts.
```json
{ "items": [ {
  "account_id": "123456789012", "region": "eu-west-1", "name": "checkout-createOrder",
  "arn": "arn:aws:lambda:…", "runtime": "nodejs22.x",
  "state": "traced" | "opted_out" | "unsupported" | "conflict" | "error" | "pending", "reason": "…" | null,
  "tracing_enabled": true, "updated_at": "…"
} ] }
```
`tracing_enabled` is the dashboard setting; a function opted out by its `ivy:trace=false` tag has `state: "opted_out"` and `tracing_enabled: true`.

### `PUT /api/aws/functions/:accountId/:region/:name`
Body `{ "tracing_enabled": false }`. Stores the setting, then attaches/detaches right away.
`{ "applied": true, "error": null, "function": {…} | null }`. If applying fails the setting is kept and the next sync retries.

### `POST /api/aws/events`
EventBridge API destination target, authenticated with the `x-ivy-event-secret` header (per connection), not user auth.
Syncs the event's region. 202, or 401/403.

## OpenAPI

### `GET /api/openapi.json`
This contract as an OpenAPI 3.1 document (hand-maintained in `src/lib/openapi/`; a test checks it lists exactly the
routes the app serves). Security scheme: OIDC bearer token, off on self-hosted setups without OIDC.

### `GET /api/docs`
API reference page (Scalar, loaded from its CDN).

## MCP

### `POST /mcp`
Remote MCP server (Streamable HTTP, stateless, JSON responses) with the tools `find_failing_invocations`,
`search_invocations`, `get_trace_summary`, `compare_invocations` and `list_error_groups`. Same tenant resolution
as `/api/*`. With OIDC configured it needs a bearer token whose audience is `IVY_MCP_RESOURCE`, and answers 401 with
`WWW-Authenticate: Bearer resource_metadata="…"` otherwise. Details: `mcp.md`.

### `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp`
RFC 9728 protected resource metadata of the MCP endpoint (only when OIDC is configured; 404 otherwise).

## Ingest (separate service, port 4318)

Not part of the API process: the ingest router (`tenancy.md`) serves OTLP/HTTP.

### `POST /v1/traces`
OTLP/HTTP `ExportTraceServiceRequest`, `application/x-protobuf` or `application/json`, optionally
`content-encoding: gzip`/`deflate`. Authenticated with `Authorization: Bearer <key>` or `x-api-key: <key>`.
Answers as OTLP/HTTP: the collector's response on success; 400, 401, 413, 415, 429 (`Retry-After`) or 503
(`Retry-After`) with a `google.rpc.Status` body otherwise. `/v1/logs` and `/v1/metrics` are 404; there is no gRPC.

### `GET /health`
`{ "ok": true }`
