# Ingest (Rust)

`packages/ingest` is a single static binary that serves OTLP/HTTP `POST /v1/traces` and writes spans to the
tenant's shard. It replaces two hops of the Node design (`docs/implementation/tenancy.md` → "Ingest path"): the Node
router, and the OpenTelemetry Collector it forwarded to.

```
client ── OTLP/HTTP ──▶ ivy-ingest :4318 ── key hash → tenant, project, shard (cached)
                          │  decode JSON or protobuf, tenant/project attributes set
                          ▼
                      write-ahead log (per shard) ── every 2 s ──▶ INSERT … FORMAT RowBinary → ivy.otel_traces
```

## Why

The layer sends one request per Lambda invocation, so per-request overhead is the cost of ingest. Measured on a
2-vCPU arm64 instance (t4g.large) running the whole stack, with realistic one-invocation gzipped JSON requests over
keep-alive TLS behind Caddy:

| ingest path | p99 < 100 ms up to | hard ceiling |
|---|---|---|
| Node router with `fetch` → collector | ~450 invocations/s | ~690/s (timeouts) |
| Node router with `node:http` → collector | ~700/s | ~1,000/s, CPU-bound |
| Rust → ClickHouse | ~1,500/s | ~1,700/s, CPU-bound (TLS proxy and ClickHouse) |

At 1,000 invocations/s the Rust service uses ~27% of a core and a few MB of memory, against ~75% plus ~250 MB for
the Node router and collector. Past the ceiling the box is saturated by the TLS proxy and ClickHouse, not ingest.

## Decisions

- **Rows identical to the collector's.** The materialized views match on the exporter's strings, so `rows.rs` maps
  like the ClickHouse exporter: span kind and status as `Server` / `Error`, IDs as lowercase hex with an all-zero ID
  as `""`, attribute values via pcommon `AsString` (doubles in ES6 number format, maps and slices as JSON with sorted
  keys), map columns sorted by key, `Duration` as unsigned `end - start` (wrapping like Go). Verified by sending the
  same payloads (JSON and protobuf, gzip and plain, edge cases) through both paths into two projects: `otel_traces`,
  `invocations`, `invocations_in_progress` and `invocations_hourly` were identical apart from the project.
- **Own write-ahead log instead of the collector's queue.** A request's rows are appended as one length-prefixed
  frame to the shard's current segment (`IVY_INGEST_WAL_DIR/<shard>/<seq>.seg`) before the client gets 200. Every
  `IVY_INGEST_FLUSH_MS` (2 s, the collector's batch timeout) or at 16 MiB the segment is sealed and inserted as one
  RowBinary INSERT (the frames are the insert body); it is deleted only after the insert succeeded. Inserts retry with
  backoff (1 s to 30 s) and keep their order. A frame cut short by a crash is dropped on replay. No fsync per request,
  like the collector's file storage: a process crash loses nothing, a host crash can lose the last seconds. Delivery is
  at least once: a crash between an insert and the segment's deletion inserts it again. Over
  `IVY_INGEST_WAL_MAX_BYTES` (2 GiB) the service answers 503 with `Retry-After: 5`, which the layer retries.
- **Fewer, larger inserts.** Flushing every 2 s rather than every second roughly halved ClickHouse's insert and merge
  CPU at 1,500 invocations/s (each insert also runs the materialized views).
- **Control-plane SQL in Rust.** Key lookup, workspace limits and the monthly trace count are the same queries as
  `packages/api` (tenancy and limits stores). They are small and stable; the alternative, asking the API, would make
  ingest depend on the API being up. Keep them in sync when those tables change.
- **Same behaviour as the Node router**: statuses and error bodies (`google.rpc.Status`, JSON or protobuf), key cache
  (60 s, 30 s negative, concurrent lookups shared), per-IP invalid-key limiting, quota gate (refresh every minute,
  local counting in between, fails open), usage counters logged every minute and served on `127.0.0.1:4320/stats`.
  The router no longer bootstraps the default tenant: the API does that on start, as before.
- **Hand-written protobuf walker** instead of prost/tonic: the OTLP trace schema is small and fixed, and the image
  stays under 2 MB (`FROM scratch`). `ivy-ingest health` replaces `wget` for healthchecks.
- **mimalloc.** The binary is a static musl build, whose allocator is slow under concurrency; mimalloc cut CPU per
  request by about a third.
- ClickHouse is reached over plain HTTP (`http://` URLs only), as inside the compose network.

## Configuration

| variable | default | |
|---|---|---|
| `IVY_INGEST_PORT` | `4318` | |
| `IVY_CLICKHOUSE_URL`, `IVY_SHARDS` | `http://localhost:8123` | shard-1, or the shard map (`clickhouse` per shard; `collector` is ignored) |
| `IVY_CLICKHOUSE_USER` / `IVY_CLICKHOUSE_PASSWORD` / `IVY_CLICKHOUSE_DATABASE` | `ivy` / `ivy` / `ivy` | |
| `IVY_CONTROL_CLICKHOUSE_URL` / `IVY_CONTROL_CLICKHOUSE_DATABASE` | shard-1 / `ivy_control` | |
| `IVY_INGEST_WAL_DIR` | `/var/lib/ivy-ingest` | mount a volume here |
| `IVY_INGEST_WAL_MAX_BYTES` | 2 GiB | |
| `IVY_INGEST_FLUSH_MS` | `2000` | |
| `IVY_INGEST_MAX_BODY_BYTES`, `IVY_INGEST_MAX_KEY_FAILURES`, `IVY_INGEST_TRUST_PROXY`, `IVY_INGEST_ADMIN_PORT/HOST` | as the Node router | |
| `IVY_QUOTA_REFRESH_SECONDS`, `IVY_QUOTA_RETRY_AFTER_SECONDS`, `IVY_PUBLIC_URL`, `IVY_UPGRADE_URL` | as the Node router | |

## Status and rollout

Built and verified (unit tests: `cargo test` in `packages/ingest`; the differential test and load tests above), not
yet wired in. Remaining, in this order:

1. Release workflow: build and push `ghcr.io/ivytrace/ivy-ingest:<sha>` (multi-arch, `packages/ingest/Dockerfile`).
2. `deploy/docker-compose.yml`: the `ingest` service runs this image with a `ingest-wal` volume and the
   `ivy-ingest health` healthcheck; the `collector` service and `deploy/collector/` go once nothing uses them.
3. Deployments that override the compose file must switch in the same release (their collector settings and ingest
   image), and drain the collector's queue before it is removed.
4. `tenancy.md` → "Ingest path" and the Node router (`packages/api/src/ingest.ts`, `lib/ingest/`) are updated or
   removed once the image is the default.
