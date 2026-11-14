# Running Ivy locally

```sh
docker compose -f deploy/docker-compose.yml up --build      # or: pnpm up
```

| service | port | notes |
|---|---|---|
| API + UI | http://localhost:3000 | UI at `/`, API at `/api/*` (see `docs/implementation/api.md`) |
| OTLP gRPC | localhost:4317 | requires `Authorization: Bearer <key>` |
| OTLP HTTP | http://localhost:4318/v1/traces | requires `Authorization: Bearer <key>` |
| ClickHouse HTTP | http://localhost:8123 | user `ivy`, password `ivy`, database `ivy` |

Environment variables (set in your shell or a `deploy/.env` file):

| variable | default | |
|---|---|---|
| `IVY_INGEST_API_KEY` | `dev-ingest-key` | ingest key; only `Authorization: Bearer` is accepted (no `x-api-key`) |
| `IVY_RETENTION_DAYS` | `30` | applied when the ClickHouse volume is first created |
| `IVY_CLICKHOUSE_USER` / `IVY_CLICKHOUSE_PASSWORD` | `ivy` / `ivy` | |
| `IVY_INGEST_PUBLIC_URL` | | collector URL that Lambda functions can reach; needed for auto-trace (`docs/implementation/auto-trace.md`) |
| `IVY_AWS_PRINCIPAL_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` | | Ivy's AWS identity for assuming the roles in connected accounts |
| `IVY_CFN_TEMPLATE_URL`, `IVY_PUBLIC_URL`, `IVY_AWS_DEFAULT_REGION`, `IVY_AWS_SYNC_INTERVAL_SECONDS` | | optional auto-trace settings |
| `IVY_BUILD_UI` | `auto` | `false` builds an API-only image |
| `IVY_API_PORT`, `IVY_OTLP_GRPC_PORT`, `IVY_OTLP_HTTP_PORT`, `IVY_CLICKHOUSE_HTTP_PORT` | 3000, 4317, 4318, 8123 | host ports |

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

Ingest without a key is rejected:

```sh
curl -i -X POST localhost:4318/v1/traces -H 'content-type: application/json' -d '{}'   # 401
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
