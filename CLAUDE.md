# Project guidelines

- Prefer clean, simple code over clever code. Only add comments where genuinely needed.
- Document implementation decisions in `docs/implementation/*.md`, not in code comments. Product decisions and requirements the user gives go into `docs/spec/`: add or extend a numbered spec (`002-product-decisions.md` collects decisions made after the v1 plan) in the same piece of work as the change. Keep both up to date as decisions change.
- pnpm monorepo. Packages live in `packages/*` and `tools/*`; `deploy/` holds docker-compose, collector config and the ClickHouse schema.
- Inside a package: `src/routes/<group>/<method>.ts` for API routes (e.g. `GET /api/invocations` → `src/routes/invocations/get.ts`), `src/lib/<folder>/*.ts` for helpers (always in a folder: `clickhouse/`, `services/`, `utils/`, or a feature name), `scripts/` for manually run scripts.
- Vitest, with tests next to the source files they cover.
- Deviations from the usual stack are deliberate (see `docs/spec/001-ivy-trace-v1.md`): pnpm instead of Yarn, ClickHouse instead of DynamoDB, docker compose instead of CDK/Lambda for the backend.
- TypeScript everywhere, with one exception: the layer's Lambda extension (`packages/layer/extension`) is Rust, because a Node process added ~30 ms to every cold start (see `docs/implementation/layer.md`).
- The UI (and later the website) is dark mode only. No light theme, no theme toggle.
- No Claude Code attribution in commits or PRs: no `Co-Authored-By: Claude` or `Claude-Session` trailers, no "Generated with Claude Code" lines.
- The product is called "Ivy" in all prose and UI. "ivytrace"/"Ivy Trace" is only for domains (ivytrace.dev) and GitHub/npm org names, because "ivy" alone is too generic.
- Keep every UI surface visually in sync: the dashboard (`packages/ui`), the MCP App views (`packages/mcp`) and the website's trace demo (`website/` in the private `ivytrace/ivy-hosted` repo). A visual change to one (colours, tabs, waterfall, service graph, icons, badges) is applied to the others in the same piece of work. The MCP App views reuse the dashboard's components rather than copying them; the website demo is a copy, so update it explicitly and note it in the hand-off when you can't.
- Docs, code, fixtures and commit messages never mention the maintainer's name or their other projects. Use neutral examples (`acme`, `checkout`, `example.com`).
- The public repo contains nothing specific to the hosted service: no prices or plans, no Stripe, no hosted infrastructure, no hosted-only identity provider or domain configuration. Those live in the private `ivytrace/ivy-hosted` docs. Public docs describe generic, configurable behaviour (e.g. "an OIDC issuer", "a billing URL", "your domain").
