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
| `IVY_OIDC_ISSUER` | | OIDC issuer URL. Set it to require sign-in for the dashboard and API; unset, both run without auth (behind your own authenticating proxy) and the UI says so (`docs/implementation/auth.md`) |
| `IVY_OIDC_CLIENT_ID` | | the dashboard's client ID at the provider (public client, code flow + PKCE); required with an issuer |
| `IVY_OIDC_AUDIENCE` | the client ID | expected `aud` of access tokens (the API's resource identifier) |
| `IVY_OIDC_SCOPES` | `openid email profile offline_access` | scopes the UI asks for |
| `IVY_OIDC_ALLOW_AGENTS` | `true` | also accept tokens of agents registered under the client (`agt_<client>_…`) |
| `IVY_SINGLE_TENANT` | `1` | every signed-in user works in the `default` workspace; `0` (with OIDC) turns on multiple workspaces, members and invitations (hosted; `docs/implementation/workspaces-projects.md`) |
| `IVY_SMTP_URL`, `IVY_EMAIL_FROM` | | send invitation emails over SMTP (e.g. `smtps://USER:PASS@email-smtp.eu-west-1.amazonaws.com:465`, `Ivy <noreply@ivytrace.dev>`); unset, the UI shows the invite link to copy |
| `IVY_SLACK_CLIENT_ID`, `IVY_SLACK_CLIENT_SECRET` | | a Slack app (from `deploy/slack-app-manifest.example.yml`) for Slack alerts per error group; also needs `IVY_PUBLIC_URL` and `IVY_SECRET_KEY` (see "Alerts" below) |
| `IVY_DIGEST_CRON` | `0 8 * * 1` | when the weekly email digest goes out (five-field cron, UTC); the digest needs `IVY_SMTP_URL`, `IVY_EMAIL_FROM` and `IVY_PUBLIC_URL` |
| `IVY_DIGEST_TO` | | comma-separated extra digest recipients for the `default` workspace (installs without sign-in have no members) |
| `IVY_ALERTS_INTERVAL_SECONDS` | `60` | how often the alert evaluator runs; `0` turns alerts and the digest off in that API process |
| `IVY_INGEST_API_KEY` | `dev-ingest-key` | key of the `default` workspace's default project, created on startup |
| `IVY_COLLECTOR_TOKEN` | `dev-collector-token` | shared secret between the router and the internal collector; set your own |
| `IVY_SECRET_KEY` | | encrypts the per-project auto-trace keys; needed for auto-trace into any project other than the default workspace's default project |
| `IVY_SHARDS` | | shard map for several cells (`tenancy.md`); one shard by default |
| `IVY_INGEST_TRUST_PROXY`, `IVY_INGEST_MAX_BODY_BYTES` | off, 10 MiB | router: client IP from `X-Forwarded-For`; body limit |
| `IVY_RETENTION_DAYS` | `30` | applied when the ClickHouse volume is first created |
| `IVY_CLICKHOUSE_USER` / `IVY_CLICKHOUSE_PASSWORD` | `ivy` / `ivy` | |
| `IVY_INGEST_PUBLIC_URL` | | ingest router URL that Lambda functions can reach; needed for auto-trace (`docs/implementation/auto-trace.md`) |
| `IVY_AWS_PRINCIPAL_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` | | Ivy's AWS identity for assuming the roles in connected accounts |
| `IVY_PUBLIC_URL`, `IVY_AWS_DEFAULT_REGION`, `IVY_AWS_SYNC_INTERVAL_SECONDS` | | optional auto-trace settings |
| `IVY_HOOKS_DIR` | `/etc/ivy/hooks` | executable hooks, e.g. `publish-cfn-template` for one-click CloudFormation links (`docs/implementation/hooks.md`; examples in `deploy/hooks.example/`) |
| `IVY_MCP_RESOURCE` | `$IVY_PUBLIC_URL/mcp` | canonical URL of the MCP endpoint, the `aud` of MCP tokens when OIDC is on (`docs/implementation/mcp.md`) |
| `IVY_INTERNAL_API_TOKEN` | | enables the internal admin API (`/internal/*`: workspace limits, usage, members) for an operator's billing service; ≥ 32 characters (`docs/implementation/limits.md`) |
| `IVY_BILLING_URL` | | billing service base URL; the dashboard's Usage page then shows Upgrade / Manage billing |
| `IVY_QUOTA_REFRESH_SECONDS`, `IVY_QUOTA_RETRY_AFTER_SECONDS`, `IVY_UPGRADE_URL` | 60, 300, `$IVY_PUBLIC_URL/w/<slug>/settings/usage` | router: monthly trace quotas |
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

## Workspaces, projects and keys

The `default` workspace, its `default` project and that project's key (`IVY_INGEST_API_KEY`) are created on
startup. Projects and their ingest keys are managed in the dashboard (Settings → Projects) or the API. From the
command line:

```sh
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs create "Acme"   # prints its key once
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs list
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs keys <tenant>
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs projects <tenant>
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs create-key <tenant> [name] --project <slug>
docker compose -f deploy/docker-compose.yml exec api node tenants.mjs revoke-key <tenant> <key id>
```

(From a checkout: `pnpm --filter @ivy/api tenants …`.) With auth off or `IVY_SINGLE_TENANT=1` the dashboard shows
only the `default` workspace. Per-tenant ingest counts: `docker compose -f deploy/docker-compose.yml exec ingest wget -qO-
http://127.0.0.1:4320/stats`.

## Limits

Workspaces are unlimited unless they have a row in `ivy_control.workspace_limits` (`docs/implementation/limits.md`).
With `IVY_INTERNAL_API_TOKEN` set:

```sh
T=…   # IVY_INTERNAL_API_TOKEN
curl -H "authorization: Bearer $T" localhost:3000/internal/workspaces                       # usage this month
curl -H "authorization: Bearer $T" -X PUT localhost:3000/internal/workspaces/<tenant>/limits \
  -H 'content-type: application/json' -d '{"plan":"Free","monthly_trace_quota":100000,"over_quota":"block"}'
curl -H "authorization: Bearer $T" -X DELETE localhost:3000/internal/workspaces/<tenant>/limits   # unlimited again
```

Over the quota, ingest answers 429 with `Retry-After`. The dashboard shows usage under Settings → Usage.

## Alerts

Slack messages per error group (first seen, then at most every 60 minutes or 100 occurrences, per project) and a
weekly email digest. Each is only on when its variables are set; the dashboard explains what is missing
(`docs/implementation/alerts.md`).

**Slack**, once per install:

1. At https://api.slack.com/apps choose *Create New App → From an app manifest*, pick a workspace you develop in, and
   paste `deploy/slack-app-manifest.example.yml` with `https://ivy.example.com` replaced by your `IVY_PUBLIC_URL`
   (the redirect URL must be exactly `<IVY_PUBLIC_URL>/api/slack/oauth/callback`).
2. Under *Basic Information → App Credentials*, copy the Client ID and Client Secret into `IVY_SLACK_CLIENT_ID` and
   `IVY_SLACK_CLIENT_SECRET`. Set `IVY_PUBLIC_URL` and `IVY_SECRET_KEY` (e.g. `openssl rand -base64 32`) if you
   haven't already, and restart the API.
3. To let other Slack workspaces install it, turn on *Manage Distribution → Public Distribution* (not needed for
   your own workspace).
4. In Ivy: *Settings → Alerts*, pick a project, *Add to Slack*, choose a channel, then *Send test message*.

**Email digest**: set `IVY_SMTP_URL`, `IVY_EMAIL_FROM` and `IVY_PUBLIC_URL`. It goes to the workspace's members
(or, without sign-in, to `IVY_DIGEST_TO`) on Mondays at 08:00 UTC; owners switch it off under *Settings → Email
digest*, everyone can unsubscribe from the email or under *Notifications*.

## Updating an existing volume

The schema is idempotent; apply it again after pulling changes (`pnpm dev` does this on every start):

```sh
pnpm db:migrate   # = docker compose -f deploy/docker-compose.yml exec -T clickhouse /docker-entrypoint-initdb.d/init.sh
```

**Volumes from before workspaces and projects** can't be updated in place (pre-release): `init.sh` stops with an
error, and a one-off reset is needed. It **deletes all data**, then recreates the schema and restarts the API and
ingest router, which recreate the `default` workspace, its project and the `IVY_INGEST_API_KEY` key:

```sh
pnpm db:reset
```

See `docs/implementation/storage.md`.

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
