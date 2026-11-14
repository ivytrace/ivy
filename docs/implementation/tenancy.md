# Tenancy

Groundwork for hosted mode (spec M6). Every row of data belongs to a tenant, the tenant is decided on the
server from the API key, and the routing seams for sharding by tenant exist now, with one shard.

## Model

- **Tenant** = **workspace** in the product (`workspaces-projects.md`): `ivy_control.tenants`, ID
  `ten_<21 base62>` (the self-hosted tenant is just `default`), a slug, a name, a `shard_id` (default `shard-1`) and
  a `default_project_id` ('' = the project with the derived ID, see `workspaces-projects.md`).
- **Project**: `ivy_control.projects`, ID `prj_…`, belongs to one tenant; every span belongs to one project.
- **API key**: `ivy_control.api_keys`, ID `key_<21 base62>`, belongs to one tenant and one project (`project_id`;
  empty for keys from before projects and the bootstrap key, meaning the workspace's current default project). The key itself is
  `ivy_<40 base62>` (~238 bits), shown once at creation. Ivy stores `sha256(key)` and a display prefix
  (`ivy_` + 6 characters), never the key. `kind` is `user`, `bootstrap` (from `IVY_INGEST_API_KEY`) or `auto-trace`
  (see below). Revoking sets `revoked_at`.
- **Shard / cell**: a full copy of the single-box data stack (collector + ClickHouse `ivy` database). The tenant
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
ingest router :4318  ── key hash → ivy_control.api_keys → tenant + project + shard (cached)
  │  same body (protobuf/JSON, gzip as sent)
  │  Authorization: Bearer $IVY_COLLECTOR_TOKEN, x-ivy-tenant: <tenant id>, x-ivy-project: <project id>
  ▼
shard collector :4318 (internal)  ── resource/tenant: delete ivy.tenant_id + ivy.project_id, insert from the headers
  ▼                                  filter/tenant: drop spans without a tenant or a project
ClickHouse ivy.otel_traces  ── TenantId/ProjectId DEFAULT ResourceAttributes['ivy.tenant_id'/'ivy.project_id']
```

### Decision: the tenant comes from the key, never from the payload

Before, `otel_traces.TenantId` defaulted from the resource attribute `ivy.tenant_id`, which any sender could set.
Now the collector deletes that attribute and inserts it again from the `x-ivy-tenant` request header
(`include_metadata: true` on the OTLP receiver + the `resource` processor with `from_context: metadata.x-ivy-tenant`).
Only the router can reach the collector (no published ports, and a shared bearer token), and the router always sets the
header from the key lookup. Spans that somehow arrive without the header are dropped by a `filter` processor rather
than stored under an empty tenant. Verified against the pinned `otel/opentelemetry-collector-contrib:0.165.0`: a span
claiming `ivy.tenant_id = evil` lands as the header's tenant, header names are matched case-insensitively, a request
without the header stores nothing, and a wrong token gets 401.

The project works the same way (`x-ivy-project` → `ivy.project_id`, `workspaces-projects.md`). Verified on 0.165.0
in the compose end-to-end run: spans that claimed another workspace's `ivy.project_id` and `ivy.tenant_id = ten_forged`
landed under the key's project and tenant; a request straight to the collector with `x-ivy-tenant` but no
`x-ivy-project` (and a client-set `ivy.project_id`) stored nothing; `X-Ivy-Project` in another case was accepted.

### Decision: the router is its own entrypoint in the API image

`packages/api/src/ingest.ts`, built to `ingest.mjs` in the same image, run as the `ingest` compose service
(`command: ["node", "ingest.mjs"]`). Not a second listener in the API process because:
- ingest is the public, high-volume, abuse-facing surface; a burst of spans must not stall dashboard requests on the
  same event loop, and the API must be able to restart without dropping ingest (and the other way round);
- with cells, routers are scaled and placed by traffic, not by dashboard use;
- it still shares the code it needs (key lookup, shard config, ClickHouse client), and there is one image to build and
  release.

It is a plain `node:http` server (no Hono): it streams-limits the body, keeps the raw bytes and forwards them with
`fetch`.

### Router behaviour

| case | answer |
|---|---|
| `POST /v1/traces` with a valid key | the collector's answer (status, body, `Retry-After`), body forwarded byte for byte |
| no key | 401 |
| unknown or revoked key, or a key of an archived project | 401; counts as a failure for the client IP |
| more than `IVY_INGEST_MAX_KEY_FAILURES` (20) failures from an IP within a minute | 429 + `Retry-After` until the minute ends, except for keys already cached as valid (so one bad client behind a shared NAT doesn't lock out others) |
| content type other than `application/x-protobuf` / `application/json` | 415 |
| body over `IVY_INGEST_MAX_BODY_BYTES` (10 MiB), or over 64 MiB decompressed | 413 |
| body that doesn't parse | 400 |
| `content-encoding` other than `gzip`, `deflate`, none | 400 |
| `/v1/logs`, `/v1/metrics` | 404 (Ivy has no logs/metrics pipeline) |
| collector unreachable or > 15 s | 503 + `Retry-After: 5` |
| key lookup failing (control database down) | 503 + `Retry-After: 5` |
| collector answers 401/403 (token misconfigured) | 503 (not the client's fault) |
| `GET /health` | 200 |

Error bodies are a `google.rpc.Status`, JSON or protobuf like the request, as OTLP/HTTP specifies. 429/502/503/504
are the statuses OTLP clients retry; the Lambda layer retries 408, 429 and 5xx with backoff and drops on other 4xx.

Server timeouts: 10 s for headers, 30 s per request. Client IP is the socket address, or the first
`X-Forwarded-For` entry with `IVY_INGEST_TRUST_PROXY=1` (only behind a proxy that sets it).

**Key cache.** Keys are looked up by hash in `ivy_control.api_keys` (one row read, with a bloom filter index on
`key_hash`), cached in memory for 60 s, unknown keys for 30 s (negative cache, so a flood of bad keys stays off the
database), concurrent lookups of one key share a query, at most 50k entries. A revoked key or a tenant move takes
effect within a minute.

**Usage counters.** Per tenant: requests, spans and bytes (as received) accepted by the collector, in memory per router
process. Logged once a minute (`[ingest] usage tenant=… requests=… spans=… bytes=…`) and served as JSON on
`http://127.0.0.1:4320/stats` (`IVY_INGEST_ADMIN_PORT`, loopback only). Counting spans means decompressing and
walking each body (a small protobuf field walker, or `JSON.parse`); the walk also counts invocations
(`ivy.invocation = true`) for quotas.

**Monthly trace quotas** (`limits.md`). After the key lookup, a tenant whose `ivy_control.workspace_limits` row has a
quota with `over_quota = block`, and whose traces this month (ClickHouse, refreshed every minute, plus this process's
count since) reached it, gets 429 with `Retry-After`. Without a row a tenant is unlimited.

### Decision: no public gRPC (4317)

Ingest is OTLP/HTTP only. The Ivy layer and loadgen use OTLP/HTTP; every OTel SDK and the Collector's `otlphttp`
exporter support it. Proxying gRPC would mean an HTTP/2 server in the router and per-message work in gRPC framing for
no current user. The collector's gRPC receiver is removed. If a customer needs gRPC, the router can grow an HTTP/2
listener later with the same key and header logic.

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
   blocks that materialized views read on insert (tried: `invocations` stayed empty), and the collector, MVs and admin
   sessions have no tenant. So the policy protects against a missing `WHERE`, not against code that bypasses the query
   helper; the static test covers that. A separate read-only ClickHouse user for the API with a fail-closed policy is
   the stronger follow-up. The control tables have no row policy (the cross-tenant lookups above need them).

## Auto-trace key

Functions get `IVY_API_KEY`, so Ivy must be able to produce a project's key in plaintext again at every sync, and a
hash can't give it back. There is one auto-trace key per project (a function's project decides its key,
`auto-trace.md`). The key used:

- the `default` tenant's default project with `IVY_INGEST_API_KEY` set: that key (self-hosted keeps working with no new configuration; the
  plaintext already lives in the environment).
- Otherwise a system-managed key of kind `auto-trace` of that project, minted the first time it is needed, stored hashed (for
  the router) and encrypted with AES-256-GCM under a key derived from `IVY_SECRET_KEY` (HKDF-SHA256), in
  `api_keys.encrypted_key`. Every process picks the oldest active one, so two processes that mint at the same moment
  still converge on one key.
- Neither available (no `IVY_SECRET_KEY` for a non-default tenant): functions show as `pending` and `GET /api/aws/setup`
  lists the issue.

Encrypting only system-managed keys (rather than every key) keeps user keys unrecoverable. Revoking the auto-trace key
(`tenants revoke-key`) makes the next sync mint a new one and rewrite every traced function. If `IVY_SECRET_KEY`
changes, old auto-trace keys can't be decrypted, so a new one is minted the same way (the old one stays valid until
revoked).

## Self-hosted bootstrap

On startup, the API and the router each ensure tenant `default` (slug `default`, shard `shard-1`) and its default
project exist, and, if `IVY_INGEST_API_KEY` is set, that it is an active `bootstrap` key without a project, so it
follows whichever project is the default (bootstrap keys written before that named the first default project and are
rewritten on startup). The API
also gives every existing tenant a slug and a default project (`ensureWorkspaceDefaults`). The key ID is derived from the hash, so
concurrent or repeated runs write the same row. Changing the variable revokes the previous bootstrap key; unsetting it
revokes nothing. The dev flow (`dev-ingest-key`) and single-tenant installs work as before, now through the router.

## Admin

Workspaces, projects and keys are managed in the dashboard and the API (`workspaces-projects.md`). For operators
there is also `packages/api/scripts/tenants.ts` (`tenants.mjs` in the image), which talks to the control database
directly (moving shards is CLI-only).

```sh
pnpm --filter @ivy/api tenants create "Acme"            # prints the tenant ID and its first key, once
pnpm --filter @ivy/api tenants list
pnpm --filter @ivy/api tenants keys <tenant>
pnpm --filter @ivy/api tenants projects <tenant>
pnpm --filter @ivy/api tenants create-key <tenant> [name] [--project <slug or id>]
pnpm --filter @ivy/api tenants revoke-key <tenant> <key id>
pnpm --filter @ivy/api tenants set-shard <tenant> <shard>
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs list   # in Docker
```

## Cells: the sharding plan

Each cell is today's stack: a collector and a ClickHouse with the `ivy` database (`otel_traces`, the MVs, the rollups).
The router and the API are cell-agnostic; `IVY_SHARDS` maps shard IDs to endpoints:

```sh
IVY_SHARDS='{"shard-1":{"clickhouse":"http://ch-1:8123","collector":"http://col-1:4318"},
             "shard-2":{"clickhouse":"http://ch-2:8123","collector":"http://col-2:4318"}}'
```

Without it there is one shard, `shard-1`, from `IVY_CLICKHOUSE_URL` and `IVY_COLLECTOR_URL`. New tenants go to
`shard-1` (`tenants create --shard` picks another). The API queries `shardClient(tenant.shardId)`; the router forwards
to `shardConfig(tenant.shardId).collector`. All cells share `IVY_COLLECTOR_TOKEN` and the ClickHouse credentials for
now.

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
   routers send the tenant's new spans to `shard-2`; within 30 s the API reads from `shard-2`.
4. **Copy the tail.** After the TTLs have passed, copy `T0 ≤ Timestamp < T1` (T1 = flip time + 2 minutes, which
   includes spans still in the source collector's queue) the same way.
5. **Check** `count()` per day for the tenant on both sides (`otel_traces` and `invocations`).
6. **Delete from the source**: `ALTER TABLE ivy.otel_traces DELETE WHERE TenantId = 'ten_X'` (and `invocations`,
   `invocations_hourly`) on `shard-1`, or let retention age it out.

Control-plane rows (`tenants`, `projects`, `api_keys`, `aws_*`, `workspace_limits`, …) don't move: they are in `ivy_control`.

## Configuration

| variable | used by | default | |
|---|---|---|---|
| `IVY_INGEST_API_KEY` | API, router | `dev-ingest-key` in compose | bootstrap key of tenant `default` |
| `IVY_COLLECTOR_TOKEN` | router, collector | `dev-collector-token` in compose | shared secret for the internal collectors; **required** by the router |
| `IVY_COLLECTOR_URL` | router | `http://localhost:4319` | `shard-1` collector when `IVY_SHARDS` is unset |
| `IVY_SHARDS` | API, router | | shard map, see above |
| `IVY_CONTROL_CLICKHOUSE_URL` / `IVY_CONTROL_CLICKHOUSE_DATABASE` | API, router | `shard-1`'s ClickHouse / `ivy_control` | control plane |
| `IVY_SECRET_KEY` | API | | encrypts auto-trace keys; needed for auto-trace of tenants other than `default` |
| `IVY_INGEST_PORT` | router | `4318` | |
| `IVY_INGEST_ADMIN_PORT` / `IVY_INGEST_ADMIN_HOST` | router | `4320` / `127.0.0.1` | `/stats` |
| `IVY_INGEST_MAX_BODY_BYTES` | router | 10 MiB | |
| `IVY_INGEST_MAX_KEY_FAILURES` | router | `20` | invalid keys per IP per minute before 429 |
| `IVY_INGEST_TRUST_PROXY` | router | off | client IP from `X-Forwarded-For` |
| `IVY_QUOTA_REFRESH_SECONDS`, `IVY_QUOTA_RETRY_AFTER_SECONDS`, `IVY_UPGRADE_URL` | router | 60, 300 | monthly quotas, `limits.md` |
| `IVY_INTERNAL_API_TOKEN` | API | | enables the internal admin API at `/internal/*` (`limits.md`) |

## Verification

- Unit tests: `scoped.test.ts` and `routes/tenant-scope.test.ts` (guards), `ingest/router.test.ts` (forwarding,
  gzip passthrough, `x-api-key`, 401/413/415/400/404/429/503, collector backpressure), `ingest/otlp.test.ts`,
  `tenancy/tenants.test.ts` (bootstrap, rotation, key hashing, auto-trace key minting/encryption).
- Compose stack (built image, internal collector): loadgen with `dev-ingest-key` lands as `default` in
  `otel_traces`, `invocations` and `invocations_hourly`; a span claiming `ivy.tenant_id = evil` sent with the default
  key lands as `default`; a tenant made with `tenants.mjs create` gets its own key and its spans land under its
  `ten_…` ID, invisible to the API (`default`); bad and missing keys get 401, an IP with too many bad keys 429; the
  collector stopped gives 503 + `Retry-After: 5` and recovers; the Lambda layer e2e
  (`IVY_ENDPOINT=http://host.docker.internal:4318`) lands under `default`; the API smoke script passes.
- Row policies: with `SQL_ivy_tenant` set, a query without a tenant filter only sees that tenant; inserts through the
  materialized views are unaffected.

## Gaps

- Monthly trace quotas exist (`limits.md`); per-query limits don't yet (M6). Router usage counters are per process and
  reset on restart.
- Row policies are fail-open without the setting (see Guards); a dedicated API ClickHouse user would close that.
- No operator (cross-workspace) admin UI; the CLI talks to the control database directly. The internal admin API
  (`limits.md`) only covers limits, usage and members, for an operator's billing service.
- The move runbook is manual and has not been rehearsed across two real cells.
- Every router decompresses and parses each body once to count spans.
