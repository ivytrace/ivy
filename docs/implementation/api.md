# API contract (v1)

Served by `packages/api` (Hono) on port `3000`. All JSON. Timestamps in responses are
ISO 8601 strings with millisecond precision (UTC). Durations are milliseconds (float).

Time range params, accepted by every list endpoint:
- `since=15m|1h|24h|7d` (default `24h`), or
- `from` / `to` as ISO strings (override `since`).

## `GET /api/health`
`{ "ok": true, "clickhouse": true }`

## `GET /api/config`
`{ "version": "0.1.0", "auth": { "enabled": false } }`
The UI shows the "authentication disabled" banner when `auth.enabled` is false.

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
