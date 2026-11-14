# Tenancy

Groundwork for hosted mode (spec M6). Every row of data belongs to a tenant, the tenant is decided on the
server from the API key, and the routing seams for sharding by tenant exist now, with one shard.

## Model

- **Tenant**: `ivy_control.tenants`, ID `ten_<21 base62>` (the self-hosted tenant is just `default`), a name and a
  `shard_id` (default `shard-1`).
- **API key**: `ivy_control.api_keys`, ID `key_<21 base62>`, belongs to one tenant. The key itself is
  `ivy_<40 base62>` (~238 bits), shown once at creation. Ivy stores `sha256(key)` and a display prefix
  (`ivy_` + 6 characters), never the key. `kind` is `user`, `bootstrap` (from `IVY_INGEST_API_KEY`) or `auto-trace`
  (see below). Revoking sets `revoked_at`.
- **Shard / cell**: a full copy of the single-box data stack (collector + ClickHouse `ivy` database). The tenant
  directory (`tenants.shard_id`) says which cell holds a tenant's spans.
- **Control plane**: the `ivy_control` database (tenants, keys, auto-trace config). One for all cells. Today it lives on
  the same ClickHouse as `shard-1`; `IVY_CONTROL_CLICKHOUSE_URL` can point it elsewhere.

All tables carry the tenant first in `ORDER BY`: `otel_traces (TenantId, …)`, `invocations (tenant_id, …)`,
`invocations_hourly (tenant_id, …)`, `aws_* (tenant_id, …)`, `api_keys (tenant_id, id)`; `tenants` is keyed by its `id`.
The two materialized views copy the tenant column through (`TenantId AS tenant_id`, then `GROUP BY tenant_id, …`), so
rollups never mix tenants. No query joins across tenants (the only join, key → tenant, is on `tenant_id`).

## Ingest path

```
client (Lambda layer, OTel SDK, loadgen)
  │  POST /v1/traces, Authorization: Bearer <key>   (or x-api-key)
  ▼
ingest router :4318  ── key hash → ivy_control.api_keys → tenant + shard (cached)
  │  same body (protobuf/JSON, gzip as sent)
  │  Authorization: Bearer $IVY_COLLECTOR_TOKEN, x-ivy-tenant: <tenant id>
  ▼
shard collector :4318 (internal)  ── resource/tenant: delete ivy.tenant_id, insert from metadata.x-ivy-tenant
  ▼                                  filter/tenant: drop spans without a tenant
ClickHouse ivy.otel_traces  ── TenantId DEFAULT ResourceAttributes['ivy.tenant_id']
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
| unknown or revoked key | 401; counts as a failure for the client IP |
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
walking each body (a small protobuf field walker, or `JSON.parse`). This is the hook for M6 quotas; nothing is enforced
yet.

### Decision: no public gRPC (4317)

Ingest is OTLP/HTTP only. The Ivy layer and loadgen use OTLP/HTTP; every OTel SDK and the Collector's `otlphttp`
exporter support it. Proxying gRPC would mean an HTTP/2 server in the router and per-message work in gRPC framing for
no current user. The collector's gRPC receiver is removed. If a customer needs gRPC, the router can grow an HTTP/2
listener later with the same key and header logic.

## API: tenant context

`packages/api/src/lib/tenancy/context.ts`. A middleware (`tenantContext`) resolves the request's tenant once and puts
`{ id, shardId }` on the Hono context; routes read it with `tenantOf(c)` and query with `dataQuery(c, sql, params)`,
which uses that tenant's shard client and binds `{tenant:String}`.

The resolver is an interface:

```ts
interface TenantResolver { resolve(c: Context): Promise<Tenant | null> }  // null → 401
```

The app uses `userTenantResolver()` (`members.ts`): `default` with auth off or in single-tenant mode (the default),
otherwise the signed-in user's tenant from `ivy_control.tenant_members`, created on their first request. See
`auth.md`, "Users and tenants". `singleTenantResolver(id)` remains for tests. `/api/health`, `/api/config` and
`/api/aws/events` (authenticated by its own secret) are registered before the middleware and have no tenant.
Tenant → shard lookups are cached for 30 s.

The background auto-trace sync runs outside requests; it works per account and always passes the account's
`tenant_id`.

## Guards

1. **Query helper + tests.** All SQL goes through `lib/clickhouse/scoped.ts`:
   - `tenantQuery(client, tenant, sql, params)` binds `tenant`, sets `SQL_ivy_tenant`, and throws unless the SQL has at
     least one `{tenant:String}` per `FROM`/`JOIN` of a tenant-scoped table.
   - `insertRows` refuses rows of tenant-scoped tables without `tenant_id`.
   - `crossTenantQuery` is the explicit escape hatch (key lookup, tenant directory, background sync, EventBridge secret
     lookup).

   `scoped.test.ts` fails if any source file calls a ClickHouse client directly outside `lib/clickhouse/`, or uses
   `crossTenantQuery` outside the reviewed files. `routes/tenant-scope.test.ts` calls every data route (with filters,
   cursors, both rollup paths, both trace lookups) against a capturing fake client and checks every query carries the
   request's tenant.
2. **Row policies** (defence in depth) on `otel_traces`, `invocations`, `invocations_hourly`:
   `USING getSettingOrDefault('SQL_ivy_tenant', '') = '' OR <tenant column> = getSettingOrDefault('SQL_ivy_tenant', '')`,
   restrictive, for all users. The API sets `SQL_ivy_tenant` on every query, so a route that forgets its tenant filter
   still only sees its tenant. Without the setting the policy passes everything: a fail-closed policy also filters the
   blocks that materialized views read on insert (tried: `invocations` stayed empty), and the collector, MVs and admin
   sessions have no tenant. So the policy protects against a missing `WHERE`, not against code that bypasses the query
   helper; the static test covers that. A separate read-only ClickHouse user for the API with a fail-closed policy is
   the stronger follow-up. The control tables have no row policy (the cross-tenant lookups above need them).

## Auto-trace key

Functions get `IVY_API_KEY`, so Ivy must be able to produce a tenant's key in plaintext again at every sync, and a
hash can't give it back. The key used:

- `default` tenant with `IVY_INGEST_API_KEY` set: that key (self-hosted keeps working with no new configuration; the
  plaintext already lives in the environment).
- Otherwise a system-managed key of kind `auto-trace`, minted the first time the tenant needs one, stored hashed (for
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

On startup, the API and the router each ensure tenant `default` (shard `shard-1`) exists, and, if
`IVY_INGEST_API_KEY` is set, that it is an active `bootstrap` key of `default`. The key ID is derived from the hash, so
concurrent or repeated runs write the same row. Changing the variable revokes the previous bootstrap key; unsetting it
revokes nothing. The dev flow (`dev-ingest-key`) and single-tenant installs work as before, now through the router.

## Admin

Until there is an admin UI: `packages/api/scripts/tenants.ts` (`tenants.mjs` in the image).

```sh
pnpm --filter @ivy/api tenants create "Acme"            # prints the tenant ID and its first key, once
pnpm --filter @ivy/api tenants list
pnpm --filter @ivy/api tenants keys <tenant>
pnpm --filter @ivy/api tenants create-key <tenant> [name]
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

Control-plane rows (`tenants`, `api_keys`, `aws_*`) don't move: they are in `ivy_control`.

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

- No quotas or per-query limits yet (M6); usage counters are per process and reset on restart.
- Row policies are fail-open without the setting (see Guards); a dedicated API ClickHouse user would close that.
- No admin API or UI for tenants and keys; the CLI talks to the control database directly.
- The move runbook is manual and has not been rehearsed across two real cells.
- Every router decompresses and parses each body once to count spans.
