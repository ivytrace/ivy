# Running Ivy locally

```sh
docker compose -f deploy/docker-compose.yml up --build      # or: pnpm up
```

| service | port | notes |
|---|---|---|
| API + UI | http://localhost:3000 | UI at `/`, API at `/api/*` (see `docs/implementation/api.md`) |
| OTLP HTTP (ingest router) | http://localhost:4318/v1/traces | `Authorization: Bearer <key>` or `x-api-key: <key>`; HTTP only, no gRPC |
| ClickHouse HTTP | http://localhost:8123 | user `ivy`, password `ivy`, databases `ivy` (spans) and `ivy_control` (tenants, keys, config) |

The collector has no published ports: only the ingest router (`ingest` service, same image as the API) talks to it,
with `IVY_COLLECTOR_TOKEN`. Tenants, keys and the router: `docs/implementation/tenancy.md`.

Environment variables (set in your shell or a `deploy/.env` file):

| variable | default | |
|---|---|---|
| `IVY_INGEST_API_KEY` | `dev-ingest-key` | key of the `default` tenant, created on startup |
| `IVY_COLLECTOR_TOKEN` | `dev-collector-token` | shared secret between the router and the internal collector; set your own |
| `IVY_SECRET_KEY` | | encrypts per-tenant auto-trace keys; needed for auto-trace of tenants other than `default` |
| `IVY_SHARDS` | | shard map for several cells (`tenancy.md`); one shard by default |
| `IVY_INGEST_TRUST_PROXY`, `IVY_INGEST_MAX_BODY_BYTES` | off, 10 MiB | router: client IP from `X-Forwarded-For`; body limit |
| `IVY_RETENTION_DAYS` | `30` | applied when the ClickHouse volume is first created |
| `IVY_CLICKHOUSE_USER` / `IVY_CLICKHOUSE_PASSWORD` | `ivy` / `ivy` | |
| `IVY_INGEST_PUBLIC_URL` | | ingest router URL that Lambda functions can reach; needed for auto-trace (`docs/implementation/auto-trace.md`) |
| `IVY_AWS_PRINCIPAL_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` | | Ivy's AWS identity for assuming the roles in connected accounts |
| `IVY_CFN_TEMPLATE_URL`, `IVY_PUBLIC_URL`, `IVY_AWS_DEFAULT_REGION`, `IVY_AWS_SYNC_INTERVAL_SECONDS` | | optional auto-trace settings |
| `IVY_MCP_RESOURCE` | `$IVY_PUBLIC_URL/mcp` | canonical URL of the MCP endpoint, the `aud` of MCP tokens when OIDC is on (`docs/implementation/mcp.md`) |
| `IVY_BUILD_UI` | `auto` | `false` builds an API-only image |
| `IVY_API_PORT`, `IVY_OTLP_HTTP_PORT`, `IVY_CLICKHOUSE_HTTP_PORT` | 3000, 4318, 8123 | host ports |

## Send test data

```sh
pnpm install
pnpm --filter loadgen start -- --count 20000 --backfill 24   # a day of history, sent in seconds
pnpm --filter loadgen start -- --count 0 --rate 10           # live traffic until Ctrl+C
pnpm --filter loadgen start -- --help
```

Options: `--count`, `--rate`, `--backfill <hours>`, `--endpoint` (default `http://localhost:4318`),
`--key` (default `$IVY_INGEST_API_KEY` or `dev-ingest-key`), `--batch`.

Check the API against the contract (needs data, e.g. after a backfill):

```sh
pnpm --filter @ivy/api smoke          # or: pnpm --filter @ivy/api smoke -- http://host:3000
```

Ingest without a valid key is rejected:

```sh
curl -i -X POST localhost:4318/v1/traces -H 'content-type: application/json' -d '{}'                              # 401
curl -i -X POST localhost:4318/v1/traces -H 'content-type: application/json' -H 'x-api-key: nope' -d '{}'         # 401
```

## Tenants and keys

The `default` tenant and its key (`IVY_INGEST_API_KEY`) are created on startup. More tenants:

```sh
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs create "Acme"   # prints its key once
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs list
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs keys <tenant>
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs revoke-key <tenant> <key id>
```

(From a checkout: `pnpm --filter @ivy/api tenants …`.) Until there is user login, the dashboard shows the
`default` tenant. Per-tenant ingest counts: `docker compose -f deploy/docker-compose.yml exec ingest wget -qO-
http://127.0.0.1:4320/stats`.

## Updating an existing volume

The schema is idempotent; apply it again after pulling changes (`pnpm dev` does this on every start):

```sh
docker compose -f deploy/docker-compose.yml exec clickhouse /docker-entrypoint-initdb.d/init.sh
```

## Query ClickHouse

```sh
docker compose -f deploy/docker-compose.yml exec clickhouse clickhouse client --user ivy --password ivy -d ivy
```

```sql
SELECT function, count(), countIf(status = 'error') FROM invocations GROUP BY function;
SELECT SpanName, Duration / 1e6 AS ms FROM otel_traces WHERE TraceId = '…' ORDER BY Timestamp;
SELECT function, hour, sum(invocations), quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q)
FROM invocations_hourly GROUP BY function, hour ORDER BY hour DESC LIMIT 20;
```

Schema and storage design: `docs/implementation/storage.md`.

## Stop

```sh
docker compose -f deploy/docker-compose.yml down       # keep data
docker compose -f deploy/docker-compose.yml down -v    # also delete ClickHouse data and the collector queue
```
