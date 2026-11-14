# Project guidelines

- Prefer clean, simple code over clever code. Only add comments where genuinely needed.
- Document implementation decisions in `docs/implementation/*.md`, not in code comments. Human-written specs live in `docs/spec/` (don't edit existing ones).
- pnpm monorepo. Packages live in `packages/*` and `tools/*`; `deploy/` holds docker-compose, collector config and the ClickHouse schema.
- Inside a package: `src/routes/<group>/<method>.ts` for API routes (e.g. `GET /api/invocations` → `src/routes/invocations/get.ts`), `src/lib/<folder>/*.ts` for helpers (always in a folder: `clickhouse/`, `services/`, `utils/`, or a feature name), `scripts/` for manually run scripts.
- Vitest, with tests next to the source files they cover.
- Deviations from the usual stack are deliberate (see `docs/spec/001-ivy-trace-v1.md`): pnpm instead of Yarn, ClickHouse instead of DynamoDB, docker compose instead of CDK/Lambda for the backend.
- The UI (and later the website) is dark mode only. No light theme, no theme toggle.
- No Claude Code attribution in commits or PRs: no `Co-Authored-By: Claude` or `Claude-Session` trailers, no "Generated with Claude Code" lines.
