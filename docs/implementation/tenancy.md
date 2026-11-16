# Tenancy

Groundwork for multi-tenant mode (spec M6). Every row of data belongs to a tenant, the tenant is decided on the
server from the API key, and the routing seams for sharding by tenant exist now, with one shard.

## Model

- **Tenant** = **workspace** in the product (`workspaces-projects.md`): `ivy_control.tenants`, ID
  `ten_<21 base62>` (the self-hosted tenant is just `default`), a slug, a name, a `shard_id` (default `shard-1`) and
  a legacy `default_project_id` (read only by the startup migration of keys without a project; see
  `workspaces-projects.md`, "There is no default project").
- **Project**: `ivy_control.projects`, ID `prj_…`, belongs to one tenant; every span belongs to one project.
- **API key**: `ivy_control.api_keys`, ID `key_<21 base62>`, belongs to one tenant and one project (`project_id`,
  always set; keys from before projects get one at startup and are rejected until then). The key itself is
  `ivy_<40 base62>` (~238 bits), shown once at creation. Ivy stores `sha256(key)` and a display prefix
  (`ivy_` + 6 characters), never the key. `kind` is `user`, `bootstrap` (from `IVY_INGEST_API_KEY`) or `auto-trace`
  (see below). Revoking sets `revoked_at`.
- **Shard / cell**: a full copy of the single-box data stack (ClickHouse with the `ivy` database). The tenant
  directory (`tenants.shard_id`) says which cell holds a tenant's spans.
- **Control plane**: the `ivy_control` database (tenants, keys, auto-trace config). One for all cells. Today it lives on
  the same ClickHouse as `shard-1`; `IVY_CONTROL_CLICKHOUSE_URL` can point it elsewhere.

All tables carry the tenant first in `ORDER BY`: `otel_traces (TenantId, ProjectId, …)`,
`invocations (tenant_id, project_id, …)`, `invocations_hourly (tenant_id, project_id, …)`, `aws_* (tenant_id, …)`,
`api_keys (tenant_id, id)`, `projects (tenant_id, id)`; `tenants` is keyed by its `id`.
The two materialized views copy tenant and project through (`TenantId AS tenant_id, ProjectId AS project_id`, then
`GROUP BY tenant_id, project_id, …`), so rollups never mix tenants or projects. No query joins across tenants (the only join, key → tenant, is on `tenant_id`).

## Ingest path

```
client (Lambda layer, OTel SDK, loadgen)
  │  POST /v1/traces, Authorization: Bearer <key>   (or x-api-key)
  ▼
ivy-ingest :4318  ── key hash → ivy_control.api_keys → tenant + project + shard (cached)
  │  decode OTLP (protobuf/JSON), set ivy.tenant_id + ivy.project_id resource attributes (client values replaced)
  ▼
write-ahead log (per shard)  ── every 2 s: INSERT … FORMAT RowBinary
  ▼
ClickHouse ivy.otel_traces  ── TenantId/ProjectId DEFAULT ResourceAttributes['ivy.tenant_id'/'ivy.project_id']
```

`ivy-ingest` is a small Rust service (`packages/ingest`); its design, write-ahead log, row mapping and measurements
are in `ingest.md`. It replaced a Node ingest router that forwarded to an internal OpenTelemetry Collector per shard.

### Decision: the tenant comes from the key, never from the payload

Before tenancy, `otel_traces.TenantId` defaulted from the resource attribute `ivy.tenant_id`, which any sender could
set. Now ingest decodes every request and sets `ivy.tenant_id` and `ivy.project_id` on every resource from the key
lookup, replacing whatever the client sent under these names, before the rows are written. There is no internal hop a
client could reach with forged values: ingest writes to ClickHouse itself. (Previously the router passed tenant and
project to the collector in `x-ivy-tenant` / `x-ivy-project` headers and the collector's processors set the
attributes; the Rust service was checked against that path to store identical rows, `ingest.md`.)

### Decision: ingest is its own service and image

`packages/ingest`, image `ghcr.io/ivytrace/ivy-ingest:<sha>` (`ivy-ingest:local` when compose builds it from
`packages/ingest/Dockerfile`), run as the `ingest` compose service. Not part of the API process because:
- ingest is the public, high-volume, abuse-facing surface; a burst of spans must not stall dashboard requests, and the
  API must be able to restart without dropping ingest (and the other way round);
- with cells, ingest is scaled and placed by traffic, not by dashboard use;
- per-request overhead is the cost of ingest (one request per Lambda invocation), and a small Rust binary that writes
  to ClickHouse directly sustains about twice the throughput of the Node router and collector on the same box
  (`ingest.md`, "Why").

The price is that the control-plane queries it needs (key lookup, workspace limits, monthly trace count) exist in Rust
as well as in `packages/api`; they are small and kept in sync by hand.

### Ingest behaviour

| case | answer |
|---|---|
| `POST /v1/traces` with a valid key | 200 with an empty `ExportTraceServiceResponse` once the rows are in the write-ahead log |
| no key | 401 |
| unknown or revoked key, or a key of an archived project | 401; counts as a failure for the client IP |
| more than `IVY_INGEST_MAX_KEY_FAILURES` (20) failures from an IP within a minute | 429 + `Retry-After` until the minute ends, except for keys already cached as valid (so one bad client behind a shared NAT doesn't lock out others) |
| content type other than `application/x-protobuf` / `application/json` | 415 |
| body over `IVY_INGEST_MAX_BODY_BYTES` (10 MiB), or over 64 MiB decompressed | 413 |
| body that doesn't parse | 400 |
| `content-encoding` other than `gzip`, `deflate`, none | 400 |
| `/v1/logs`, `/v1/metrics` | 404 (Ivy has no logs/metrics pipeline) |
| write-ahead log over `IVY_INGEST_WAL_MAX_BYTES` (ClickHouse down or behind) | 503 + `Retry-After: 5` |
| key lookup failing (control database down) | 503 + `Retry-After: 5` |
| `GET /health` | 200 |

Error bodies are a `google.rpc.Status`, JSON or protobuf like the request, as OTLP/HTTP specifies. 429/502/503/504
are the statuses OTLP clients retry; the Lambda layer retries 408, 429 and 5xx with backoff and drops on other 4xx.

Server timeouts: 10 s for headers, 30 s per request. Client IP is the socket address, or the first
`X-Forwarded-For` entry with `IVY_INGEST_TRUST_PROXY=1` (only behind a proxy that sets it).

**Key cache.** Keys are looked up by hash in `ivy_control.api_keys` (one row read, with a bloom filter index on
`key_hash`), cached in memory for 60 s, unknown keys for 30 s (negative cache, so a flood of bad keys stays off the
database), concurrent lookups of one key share a query, at most 50k entries. A revoked key or a tenant move takes
effect within a minute.

**Usage counters.** Per tenant: requests, spans and bytes (as received) accepted, in memory per ingest process.
Logged once a minute (`[ingest] usage tenant=… requests=… spans=… bytes=…`) and served as JSON on
`http://127.0.0.1:4320/stats` (`IVY_INGEST_ADMIN_PORT`, loopback only). Spans are counted while each body is decoded
into rows, and the same pass counts invocations (`ivy.invocation = true`) for quotas.

**Monthly trace quotas** (`limits.md`). After the key lookup, a tenant whose `ivy_control.workspace_limits` row has a
quota with `over_quota = block`, and whose traces this month (ClickHouse, refreshed every minute, plus this process's
count since) reached it, gets 429 with `Retry-After`. Without a row a tenant is unlimited.

### Note: per-request overhead

The layer sends one OTLP request per Lambda invocation, so the fixed cost of a request dominates. The Node router
first lost almost half its CPU to `fetch` (undici) when forwarding; replacing it with `node:http` took it from ~450 to
~700 invocations/s with p99 under 100 ms on a 2-vCPU instance. The Rust service roughly doubled that again; the
comparison is in `ingest.md`.

### Decision: no public gRPC (4317)

Ingest is OTLP/HTTP only. The Ivy layer and loadgen use OTLP/HTTP; every OTel SDK and the Collector's `otlphttp`
exporter support it. gRPC would mean an HTTP/2 server in ingest and per-message work in gRPC framing for no current
user. If a customer needs gRPC, ingest can grow an HTTP/2 listener later with the same key and tenancy logic.

## API: workspace context

`packages/api/src/lib/tenancy/context.ts`. Every data and management route is under `/api/w/:workspace` (and
`/api/w/:workspace/p/:project`). Middleware resolves the workspace once per request through a `WorkspaceAccess`
(`find(c, ref)` by slug or ID, checking membership; null → 404, the same as a missing workspace), puts
`{ id, shardId }` (`tenantOf(c)`), the membership (`membershipOf(c)`: workspace record + role) and, under
`/p/:project`, the project (`projectOf(c)`) on the Hono context. Data routes take a `DataScope`
(`{ tenant, projectId }`, `projectId: null` only on routes mounted with `allProjects()`) and query through
`scopedDataQuery(scope, sql, params)`, which uses the tenant's shard and binds `{tenant:String}` and
`{project:String}`. The query functions in `lib/data/` take a `DataScope` rather than a request, so other callers
(the MCP server) can query per workspace and per project without Hono.

The app uses `userWorkspaceAccess()` (`members.ts`): `default`, owned by everyone, with auth off or in single-tenant
mode (the default); otherwise the signed-in user's memberships in `ivy_control.tenant_members` (`auth.md`, "Users
and tenants", and `workspaces-projects.md`). `fixedWorkspaceAccess(workspace, role)` is for tests. `/api/health`,
`/api/config` and `/api/aws/events` (authenticated by its own secret) have no workspace. Tenant → shard lookups are
cached for 30 s, memberships for 5 s, a workspace's projects for 10 s (writes in the same process clear them).

The background auto-trace sync runs outside requests; it works per account and always passes the account's
`tenant_id`.

## Guards

1. **Query helper + tests.** All SQL goes through `lib/clickhouse/scoped.ts`:
   - `scopedQuery(client, { tenant, project | allProjects }, sql, params)` binds `tenant` (and `project`), sets
     `SQL_ivy_tenant` (and `SQL_ivy_project`), and throws unless the SQL has at least one `{tenant:String}` per
     `FROM`/`JOIN` of a tenant-scoped table, and at least one `{project:String}` per reference to a span table
     (`otel_traces`, `invocations`, `invocations_hourly`), unless the scope says `allProjects: true`. Only the
     workspace-wide function overview and error groups use that. `tenantQuery(client, tenant, …)` is the control-plane
     form (no project; reading a span table through it throws).
   - `insertRows` refuses rows of tenant-scoped tables without `tenant_id`.
   - `crossTenantQuery` is the explicit escape hatch (key lookup, tenant directory, background sync, EventBridge secret
     lookup).

   `scoped.test.ts` fails if any source file calls a ClickHouse client directly outside `lib/clickhouse/`, or uses
   `crossTenantQuery` outside the reviewed files. `routes/tenant-scope.test.ts` calls every data route (with filters,
   cursors, both rollup paths, both trace lookups) against a capturing fake client and checks every query carries the
   request's tenant and project (projects by slug and by ID), and that the workspace-wide routes are the only
   all-projects queries.
2. **Row policies** (defence in depth) on `otel_traces`, `invocations`, `invocations_hourly`:
   `USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR <tenant column> = getSettingOrDefault('SQL_ivy_tenant', '')`,
   restrictive, for all users; and `ivy_project` the same way with `SQL_ivy_project` and the project column. The API sets `SQL_ivy_tenant` on every query, so a route that forgets its tenant filter
   still only sees its tenant. Without the setting the policy passes everything: a fail-closed policy also filters the
   blocks that materialized views read on insert (tried: `invocations` stayed empty), and ingest inserts, MVs and admin
   sessions have no tenant. So the policy protects against a missing `WHERE`, not against code that bypasses the query
   helper; the static test covers that. A separate read-only ClickHouse user for the API with a fail-closed policy is
   the stronger follow-up. The control tables have no row policy (the cross-tenant lookups above need them).

## Auto-trace key

Functions get `IVY_API_KEY`, so Ivy must be able to produce a project's key in plaintext again at every sync, and a
hash can't give it back. There is one auto-trace key per project (a function's project decides its key,
`auto-trace.md`). The key used:

- the project the `IVY_INGEST_API_KEY` bootstrap key belongs to (in the `default` tenant): that key (self-hosted keeps
  working with no new configuration; the plaintext already lives in the environment). Null when that project is archived.
- Otherwise a system-managed key of kind `auto-trace` of that project, minted the first time it is needed, stored hashed (for
  ingest) and encrypted with AES-256-GCM under a key derived from `IVY_SECRET_KEY` (HKDF-SHA256), in
  `api_keys.encrypted_key`. Every process picks the oldest active one, so two processes that mint at the same moment
  still converge on one key.
- Neither available (no `IVY_SECRET_KEY` for any other project): functions show as `pending` and `GET /api/aws/setup`
  lists the issue. There is no key for "no project": a function without one is `needs_project` and not traced.

Encrypting only system-managed keys (rather than every key) keeps user keys unrecoverable. Revoking the auto-trace key
(`tenants revoke-key`) makes the next sync mint a new one and rewrite every traced function. If `IVY_SECRET_KEY`
changes, old auto-trace keys can't be decrypted, so a new one is minted the same way (the old one stays valid until
revoked).

## Self-hosted bootstrap

On startup, the API first gives every key without a project its workspace's former default project
(`assignProjectlessKeys`, see `workspaces-projects.md`, "There is no default project"), then ensures tenant `default`
(slug `default`, shard `shard-1`) exists and, if `IVY_INGEST_API_KEY` is set, that it is an active `bootstrap` key of an
ordinary project: "Default" (slug `default`, derived ID), created the first time. A new value of the variable revokes
the previous bootstrap key and takes over its project while that is active. It also gives every existing tenant a
slug (`ensureWorkspaceSlugs`). Ingest does none of this (the Node router used to run the same bootstrap); a key is
accepted once the API has written it. The key ID is derived from the hash, so concurrent or repeated runs write the same row.
Unsetting the variable revokes nothing. The dev flow (`dev-ingest-key`) and single-tenant installs work as before.

## Admin

Workspaces, projects and keys are managed in the dashboard and the API (`workspaces-projects.md`). For operators
there is also `packages/api/scripts/tenants.ts` (`tenants.mjs` in the image), which talks to the control database
directly (moving shards is CLI-only).

```sh
pnpm --filter @ivy/api tenants create "Acme" [--project "Checkout"]   # a first project (default name "Default") and its key, shown once
pnpm --filter @ivy/api tenants list
pnpm --filter @ivy/api tenants keys <tenant>
pnpm --filter @ivy/api tenants projects <tenant>
pnpm --filter @ivy/api tenants create-key <tenant> --project <slug or id> [name]
pnpm --filter @ivy/api tenants revoke-key <tenant> <key id>
pnpm --filter @ivy/api tenants set-shard <tenant> <shard>
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs list   # in Docker
```

## Cells: the sharding plan

Each cell is a ClickHouse with the `ivy` database (`otel_traces`, the MVs, the rollups). Ingest and the API are
cell-agnostic; `IVY_SHARDS` maps shard IDs to ClickHouse URLs:

```sh
IVY_SHARDS='{"shard-1":{"clickhouse":"http://ch-1:8123"},
             "shard-2":{"clickhouse":"http://ch-2:8123"}}'
```

Without it there is one shard, `shard-1`, from `IVY_CLICKHOUSE_URL`. A `"collector"` key from older configurations is
ignored. New tenants go to `shard-1` (`tenants create --shard` picks another). The API queries
`shardClient(tenant.shardId)`; ingest keeps a write-ahead log per shard and inserts into that shard's ClickHouse. All
cells share the ClickHouse credentials for now.

### Moving a tenant between shards (runbook)

Because the tenant is the leading key everywhere, a tenant's rows are a contiguous range in every table and can be
copied with `INSERT … SELECT … WHERE`. Run on the target cell's ClickHouse, reading the source with `remote()`
(or `remoteSecure()`), for tenant `ten_X` from `shard-1` to `shard-2`:

1. **Dual period starts.** Note the time `T0`. Nothing changes for ingest yet.
2. **Copy history.** Copy only `otel_traces`. On the target, inserting into it fires `invocations_mv` and then
   `invocations_hourly_mv`, which rebuild the tenant's `invocations` and rollups (with the target's MV definitions).
   Copying `invocations` or `invocations_hourly` as well would count everything twice.

   ```sql
   -- on shard-2
   INSERT INTO ivy.otel_traces
   SELECT * FROM remote('ch-1:9000', ivy.otel_traces, 'ivy', '<password>')
   WHERE TenantId = 'ten_X' AND Timestamp < '<T0>'
   SETTINGS SQL_ivy_tenant = 'ten_X';  -- the source's row policy then only lets this tenant's rows through
   ```

   For large tenants, copy one day at a time (`AND toDate(Timestamp) = '…'`). To redo a day, first delete it on the
   target from all three tables (`ALTER TABLE … DELETE WHERE TenantId/tenant_id = 'ten_X' AND …`).
3. **Flip the shard.** `pnpm --filter @ivy/api tenants set-shard ten_X shard-2`. Within a minute (key cache TTL) the
   ingest processes send the tenant's new spans to `shard-2`; within 30 s the API reads from `shard-2`.
4. **Copy the tail.** After the TTLs have passed, copy `T0 ≤ Timestamp < T1` (T1 = flip time + 2 minutes, which
   includes spans still in the source shard's write-ahead log) the same way.
5. **Check** `count()` per day for the tenant on both sides (`otel_traces` and `invocations`).
6. **Delete from the source**: `ALTER TABLE ivy.otel_traces DELETE WHERE TenantId = 'ten_X'` (and `invocations`,
   `invocations_hourly`) on `shard-1`, or let retention age it out.

Control-plane rows (`tenants`, `projects`, `api_keys`, `aws_*`, `workspace_limits`, …) don't move: they are in `ivy_control`.

## Configuration

| variable | used by | default | |
|---|---|---|---|
| `IVY_INGEST_API_KEY` | API | `dev-ingest-key` in compose | bootstrap key of tenant `default` |
| `IVY_SHARDS` | API, ingest | | shard map, see above |
| `IVY_CONTROL_CLICKHOUSE_URL` / `IVY_CONTROL_CLICKHOUSE_DATABASE` | API, ingest | `shard-1`'s ClickHouse / `ivy_control` | control plane |
| `IVY_SECRET_KEY` | API | | encrypts auto-trace keys; needed for auto-trace of tenants other than `default` |
| `IVY_INGEST_PORT` | ingest | `4318` | |
| `IVY_INGEST_ADMIN_PORT` / `IVY_INGEST_ADMIN_HOST` | ingest | `4320` / `127.0.0.1` | `/stats` |
| `IVY_INGEST_MAX_BODY_BYTES` | ingest | 10 MiB | |
| `IVY_INGEST_MAX_KEY_FAILURES` | ingest | `20` | invalid keys per IP per minute before 429 |
| `IVY_INGEST_TRUST_PROXY` | ingest | off | client IP from `X-Forwarded-For` |
| `IVY_QUOTA_REFRESH_SECONDS`, `IVY_QUOTA_RETRY_AFTER_SECONDS`, `IVY_UPGRADE_URL` | ingest | 60, 300 | monthly quotas, `limits.md` |
| `IVY_INTERNAL_API_TOKEN` | API | | enables the internal admin API at `/internal/*` (`limits.md`) |

Ingest's own settings (write-ahead log directory and size, flush interval) are in `ingest.md`, "Configuration".

## Verification

- Unit tests: `scoped.test.ts` and `routes/tenant-scope.test.ts` (guards), `tenancy/tenants.test.ts` (bootstrap,
  rotation, key hashing, auto-trace key minting/encryption); `cargo test` in `packages/ingest` (OTLP decoding, row
  mapping and the tenant attributes, write-ahead log, key hashing, invalid-key limiting).
- Row compatibility: the same payloads sent through the old collector path and through `ivy-ingest` into two projects
  gave identical `otel_traces`, `invocations` and rollups apart from the project (`ingest.md`, "Decisions").
- Compose stack (built images): loadgen with `dev-ingest-key` lands as `default` in
  `otel_traces`, `invocations` and `invocations_hourly`; a span claiming `ivy.tenant_id = evil` sent with the default
  key lands as `default`; a tenant made with `tenants.mjs create` gets its own key and its spans land under its
  `ten_…` ID, invisible to the API (`default`); bad and missing keys get 401, an IP with too many bad keys 429; the
  Lambda layer e2e
  (`IVY_ENDPOINT=http://host.docker.internal:4318`) lands under `default`; the API smoke script passes.
- Row policies: with `SQL_ivy_tenant` set, a query without a tenant filter only sees that tenant; inserts through the
  materialized views are unaffected.

## Gaps

- Monthly trace quotas exist (`limits.md`); per-query limits don't yet (M6). Ingest usage counters are per process and
  reset on restart.
- Row policies are fail-open without the setting (see Guards); a dedicated API ClickHouse user would close that.
- No operator (cross-workspace) admin UI; the CLI talks to the control database directly. The internal admin API
  (`limits.md`) only covers limits, usage and members, for an operator's billing service.
- The move runbook is manual and has not been rehearsed across two real cells.
