# Ivy

Open-source observability for AWS Lambda (Node.js first). One `docker compose up`
runs everything: OTLP ingest (Rust) → ClickHouse → API (Hono) → UI (React).

## Self-hosting

Ivy runs on one machine with Docker. It is sized for about 300k invocations a day on 2 vCPU / 8 GB.

```sh
git clone https://github.com/ivytrace/ivy.git && cd ivy
touch deploy/.env           # then fill in the variables below
docker compose -f deploy/docker-compose.yml up -d --build
```

The dashboard and API listen on port 3000, OTLP ingest on 4318. Put both behind a reverse proxy with TLS (Caddy,
nginx, a load balancer), for example `ivy.example.com` → `:3000` and `ingest.ivy.example.com` → `:4318`.
Instead of building, you can use the published images: replace the `build:` entries with
`image: ghcr.io/ivytrace/ivy-api:main` (API and dashboard) and `image: ghcr.io/ivytrace/ivy-ingest:main` (ingest).

A minimal `deploy/.env`:

```sh
IVY_PUBLIC_URL=https://ivy.example.com
IVY_INGEST_PUBLIC_URL=https://ingest.ivy.example.com
IVY_SECRET_KEY=…              # openssl rand -base64 32
IVY_CLICKHOUSE_PASSWORD=…
IVY_INGEST_API_KEY=…          # a first ingest key, created on startup (the default, dev-ingest-key, is public)

# Sign-in with any OIDC provider. Without it, the dashboard and API have no auth (only run it behind
# an authenticating proxy then).
IVY_OIDC_ISSUER=https://auth.example.com
IVY_OIDC_CLIENT_ID=…

# Auto-tracing: the AWS identity Ivy uses to assume the role in each connected account.
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_REGION=eu-west-1
```

Then open the dashboard, create a project and connect an AWS account (Settings → AWS accounts): Ivy adds its
layer to the functions you pick. Email (invitations, weekly digest) and Slack alerts are optional. All variables,
upgrading an existing install and stopping it: [`deploy/README.md`](deploy/README.md).

To upgrade, `git pull` and run the same `up` command again, then apply schema changes:
`docker compose -f deploy/docker-compose.yml exec -T clickhouse /docker-entrypoint-initdb.d/init.sh`.

## Development

```sh
pnpm install
pnpm dev        # ClickHouse + ingest in Docker; API and dashboard with hot reload
                # dashboard: http://localhost:5173, API: :3000, OTLP/HTTP: :4318 (key dev-ingest-key)
pnpm --filter loadgen start -- --count 5000 --backfill 24   # sample data
pnpm dev:mock   # dashboard only, with fixture data (no Docker)
pnpm up         # full production-like stack in Docker (http://localhost:3000)
pnpm down       # stop containers (data is kept in volumes)
```

## For agents

Ivy has no CLI; agents use MCP or the HTTP API:

```sh
claude mcp add --transport http ivy http://localhost:3000/mcp     # tools: find_failing_invocations, get_trace_summary, …
curl 'http://localhost:3000/api/traces/<trace id>?format=text'    # one trace as a compact text tree
open http://localhost:3000/api/docs                               # API reference (OpenAPI at /api/openapi.json)
```

The MCP tools cover all of your workspaces. `render_waterfall` and `render_graph` show a trace as an
interactive view (MCP Apps) in hosts that support it, and as text elsewhere. With OIDC configured, `/mcp` is an
OAuth protected resource (`docs/implementation/mcp.md`).

See `docs/implementation/span-conventions.md`, `docs/implementation/api.md`, `docs/implementation/mcp.md` and
`docs/implementation/tenancy.md` (tenants, API keys, sharding plan) and `docs/implementation/ingest.md` (the ingest
service).

## License

MIT, see [LICENSE](LICENSE).
