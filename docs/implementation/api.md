# API contract (v1)

Served by `packages/api` (Hono) on port `3000`. All JSON. Timestamps in responses are
ISO 8601 strings with millisecond precision (UTC). Durations are milliseconds (float).
Errors are `{ "error": "…" }` with a 4xx/5xx status.

The OpenAPI 3.1 version of this contract is served at `GET /api/openapi.json`, with a reference page at
`GET /api/docs` (both public). Agents can also use the MCP server at `/mcp` (see below and `mcp.md`).

## Auth

`auth.md`: with OIDC configured (`IVY_OIDC_ISSUER`), every `/api/*` route except `GET /api/health`,
`GET /api/config`, `POST /api/aws/events`, `GET /api/openapi.json` and `GET /api/docs` needs
`Authorization: Bearer <access token>` (a JWT from the configured
issuer, for `IVY_OIDC_AUDIENCE`, issued to the dashboard's client or one of its agents). Without it: 401
`{ "error": "Authentication required" }`; invalid or expired: 401 with `WWW-Authenticate: Bearer error="invalid_token"`;
provider unreachable: 503. Without OIDC configured nothing is checked.

## Workspaces, projects and scoping

The model is in `workspaces-projects.md`. A **workspace** (internally: tenant) has members, AWS accounts and
projects. A **project** has ingest keys, and every span belongs to exactly one project.

Everything except the routes in "Account-level routes" lives under a workspace:

```
/api/w/:workspace/…                 workspace routes (members, invitations, projects, AWS, workspace-wide data)
/api/w/:workspace/p/:project/…      project routes (data, ingest keys)
```

- `:workspace` is the workspace's slug (e.g. `acme`) or ID (`ten_…`, or `default`). `:project` is the project's
  slug (e.g. `checkout-prod`) or ID (`prj_…`). Slugs are lower-case letters, digits and dashes (1–40 chars);
  `all` and `settings` are not allowed as project slugs.
- **Membership is checked on every request.** A workspace that doesn't exist and one the caller isn't a member of
  both answer **404** `{ "error": "Workspace not found" }`. An unknown project in a workspace: 404
  `{ "error": "Project not found" }`. Archived projects stay readable.
- **Roles:** `owner` or `member`. Owner-only routes are marked; a member gets **403**
  `{ "error": "Only workspace owners can do this" }`. Members can read data and manage projects, ingest keys and
  AWS accounts.
- **Single-workspace mode.** With auth off, or with OIDC on and `IVY_SINGLE_TENANT` unset or `1` (self-hosted
  default), there is exactly one workspace, `default`, and every caller is its owner. Creating and deleting
  workspaces, members and invitations answer **403** in this mode
  (`{ "error": "… needs sign-in with IVY_SINGLE_TENANT=0; this install has a single workspace (default)" }`);
  `GET /api/config` says which mode is on (`workspaces.multi`) so the UI hides those parts. Renaming the
  default workspace, projects, keys and AWS work in both modes.

Why path segments rather than `?workspace=&project=` query params: the workspace middleware runs once for the
whole prefix, so no data route can forget the membership check or the project filter; URLs are the same shape as
the dashboard's (`/w/:workspace/:project/…`); and agents/MCP tools can build them from two slugs.

## Public routes

### `GET /api/health`
`{ "ok": true, "clickhouse": true }` (the control database and every shard answer a ping; 503 otherwise)

### `GET /api/config`
```json
{ "version": "0.1.0",
  "auth": { "enabled": true, "issuer": "https://auth.includable.com", "clientId": "ivy", "audience": "https://ivytrace.dev/api", "scopes": "openid email profile offline_access" },
  "workspaces": { "multi": true },
  "email": { "enabled": true },
  "aws": { "quick_create": true } }
```
With auth off: `"auth": { "enabled": false }` and `"workspaces": { "multi": false }`. `email.enabled` is true when
`IVY_SMTP_URL` and `IVY_EMAIL_FROM` are set (invitations are then also emailed). `aws.quick_create` is true when
the `publish-cfn-template` hook is installed (see "Hosting hooks"); otherwise connecting AWS is download-only.
With `IVY_BILLING_URL` set it also has `"billing": { "url": "https://ivytrace.dev/billing" }`: the usage page then
shows owners "Upgrade" / "Manage billing" (`limits.md`).

## Account-level routes

### `GET /api/workspaces`
The caller's workspaces, oldest membership first. In multi-workspace mode a signed-in user without any gets a
personal workspace (they own it) on this call.
```json
{ "items": [ { "id": "ten_4Fq…", "slug": "acme", "name": "Acme", "role": "owner", "default": false, "created_at": "…" } ] }
```

### `POST /api/workspaces`
Body `{ "name": "Acme" }`. Creates the workspace with a `default` project; the caller becomes its owner. The slug is
generated from the name (lower case, accents folded, other characters → `-`, at most 40 characters, `workspace` if
nothing is left) and made unique across workspaces by appending `-2`, `-3`, …; concurrent creates never get the same
slug. An optional `"slug"` is used as given instead (409 if taken); the dashboard doesn't send it. 201 with the
workspace (as in the list). 400 invalid name/slug, 403 in single-workspace mode.

### `GET /api/invitations/:token`
What an invite link is for (needs a signed-in user):
```json
{ "workspace": { "slug": "acme", "name": "Acme" }, "email": "erin@example.com", "role": "member",
  "status": "pending" | "accepted" | "revoked" | "expired", "invited_by": "owner@example.com" | null, "expires_at": "…" }
```
404 for an unknown token. 403 when auth is off.

### `POST /api/invitations/:token/accept`
Accepts the invitation for the signed-in user. Rules: the invitation must be `pending` (else **410** with
"already been used" / "revoked" / "expired"); the user's email must equal the invited email (case-insensitive)
**and** the identity provider must say it is verified (`email_verified`, from the access token or else the
provider's userinfo endpoint); otherwise **403** with a message saying which. Success:
`{ "accepted": true, "workspace": { "id": "…", "slug": "acme", "name": "Acme", "role": "member", "default": false, "created_at": "…" } }`.
An existing owner keeps the owner role.

## Workspace routes (`/api/w/:workspace`)

### `GET /api/w/:workspace`
The workspace as in `GET /api/workspaces`, with the caller's role, plus `default_project_id`: the workspace's default
project.

### `PATCH /api/w/:workspace`
Body: any of `name`, `slug` (owner), `default_project` (any member). Renaming doesn't change the slug, so URLs stay
stable; changing the slug is a separate, explicit edit ("Change URL"). 409 if the slug is taken; the `default`
workspace's slug can't change. `default_project` (slug or ID of an active project, 400 otherwise) makes that project
the default: keys without a project and functions traced without a project go there from now on (keys within the
router's one-minute key cache, functions at the next sync).

### `DELETE /api/w/:workspace?confirm=<slug>` (owner)
`confirm` must repeat the slug (400 otherwise). 409 while AWS accounts are connected (disconnect them first) and
for the `default` workspace. Revokes every ingest key, removes members and pending invitations. Spans are not
deleted; retention drops them. `{ "deleted": true }`.

### Members (multi-workspace mode)

- `GET /api/w/:workspace/members` →
  `{ "items": [ { "sub": "idn_…", "email": "erin@example.com" | null, "role": "owner", "you": true, "joined_at": "…" } ] }`
- `PATCH /api/w/:workspace/members/:sub` (owner), body `{ "role": "owner" | "member" }` → the member. 409 when it
  would leave the workspace without an owner.
- `DELETE /api/w/:workspace/members/:sub` (owner; or anyone for their own `sub`, i.e. leaving) →
  `{ "removed": true }`. 409 for the last owner.

### Invitations (multi-workspace mode, owner)

- `GET /api/w/:workspace/invitations` (`?all=1` includes accepted/revoked/expired) →
  `{ "items": [ { "id": "inv_…", "email": "erin@example.com", "role": "member", "status": "pending", "invited_by": "owner@example.com" | null, "created_at": "…", "expires_at": "…", "accepted_at": null } ] }`
- `POST /api/w/:workspace/invitations`, body `{ "email": "erin@example.com", "role"?: "member" | "owner" }` → 201
  ```json
  { "invitation": { "id": "inv_…", "…": "…" }, "url": "https://ivytrace.dev/invite/<token>",
    "email_sent": true, "email_error": null }
  ```
  The `url` (with the token) is returned only here; Ivy stores only the token's hash. It expires after 7 days and
  works once. A new invitation for the same email revokes the previous pending one. 409 if the email is already a
  member. The link's origin is `IVY_PUBLIC_URL`, else the request's `Origin`.
- `DELETE /api/w/:workspace/invitations/:id` → the revoked invitation. 409 if it isn't pending.

### `GET /api/w/:workspace/usage`
This month's traces (Lambda invocations, calendar month in UTC) of **all the workspace's projects**, and the
workspace's limits. Any member. The count is exact and cached for up to a minute. Billing is per workspace, so there
is no per-project usage route.
```json
{ "workspace": "ten_4Fq…", "month": "2026-11",
  "period": { "start": "2026-11-01T00:00:00.000Z", "end": "2026-12-01T00:00:00.000Z" },
  "traces": 62418,
  "limits": { "plan": "Free", "monthly_trace_quota": 100000, "over_quota": "block", "source": "workspace" },
  "blocked": false }
```
`monthly_trace_quota: null` is unlimited; `source: "unset"` means the workspace has no limits (unlimited, the default).
`blocked`: ingest is answering 429 (quota reached with `over_quota: "block"`). See `limits.md`.

### Projects

- `GET /api/w/:workspace/projects` (`?archived=1` includes archived) →
  `{ "items": [ { "id": "prj_…", "slug": "checkout-prod", "name": "Checkout (prod)", "archived": false, "default": false, "created_at": "…" } ] }`
  `default` (boolean) marks the workspace's default project, where keys without a project and functions traced
  without a project go. Every workspace starts with one; the designation moves with `PATCH /api/w/:workspace`
  (`default_project`) or when the default project is archived.
- `POST /api/w/:workspace/projects`, body `{ "name": "Checkout (prod)" }` → 201 with the project. The slug is
  generated from the name like workspace slugs (`checkout-prod`; fallback `project`), unique within the workspace
  (`-2`, `-3`, … on collisions; `all` and `settings` are skipped). An optional `"slug"` is used as given instead (409 if
  it exists in the workspace).
- `GET /api/w/:workspace/p/:project` → the project.
- `PATCH /api/w/:workspace/p/:project`, body: any of `name`, `slug`, `archived` (boolean), `new_default` → the
  project. Renaming doesn't change the slug. Archiving stops the keys created for it from ingesting (401 at the
  router) and re-syncs AWS accounts so no function sends to it. Archiving the **default** project first makes
  `new_default` (slug or ID of another active project; 400 otherwise) the default, or without it the oldest remaining
  active project; keys without a project then send to the new default. 409 "A workspace needs at least one project"
  for the last active project. `new_default` is ignored for other projects.

### Ingest keys of a project

- `GET /api/w/:workspace/p/:project/keys` (`?revoked=1` includes revoked) →
  `{ "items": [ { "id": "key_…", "name": "ci", "kind": "user" | "auto-trace" | "bootstrap", "prefix": "ivy_Ab12Cd", "created_at": "…", "revoked_at": null } ] }`
- `POST /api/w/:workspace/p/:project/keys`, body `{ "name"?: "ci" }` → 201
  `{ "id": "key_…", "name": "ci", "kind": "user", "prefix": "ivy_Ab12Cd", "created_at": "…", "revoked_at": null, "key": "ivy_Ab12Cd…", "endpoint": "https://ingest.ivytrace.dev" | null }`.
  `key` appears only in this response. 409 for an archived project.
- `DELETE /api/w/:workspace/p/:project/keys/:id` → the revoked key. Ingest with it stops within a minute. Revoking
  the `auto-trace` key makes the next sync mint a new one and rewrite the project's functions. 409 for the
  `bootstrap` key (`IVY_INGEST_API_KEY`).

Use a key with `Authorization: Bearer <key>` against the ingest endpoint (below). The spans land in the key's
project.

## Data routes

Project-scoped, under `/api/w/:workspace/p/:project`:

| route | |
|---|---|
| `GET …/functions` | function overview |
| `GET …/invocations` | invocations |
| `GET …/traces/:traceId` | one trace |
| `GET …/errors` | error groups |
| `GET …/stats/timeseries` | totals over time |

Workspace-wide (every project of the workspace), under `/api/w/:workspace`:

| route | |
|---|---|
| `GET …/functions` | function overview; each item also has `"project_id": "prj_…", "project": "checkout-prod"` |
| `GET …/invocations` | invocations of every project, same filters and cursor pagination; each item also has `project_id` and `project` |
| `GET …/errors` | error groups; each item also has `project_id` and `project` |
| `GET …/stats/timeseries` | totals over time, summed over every project; `project` (slug or ID) narrows to one |

These routes are mounted with `allProjects()`: they read the tenant explicitly without a project filter, and the query
guard still requires the tenant filter on every table reference (`workspaces-projects.md`, "The query guard knows
projects"). There is no workspace-wide trace route: open a trace under the project an invocation row names. A function
name used in two projects is two rows in `functions`; `stats/timeseries?function=` sums both unless `project` is given.
Failure fields (`failure_phase`, `failure_kind`, `synthetic`) and throttles behave as in the project routes.

A trace or invocation from another project of the same workspace is not visible under a project's routes (404 /
not listed).

Time range params, accepted by every list endpoint:
- `since=15m|1h|24h|7d` (default `24h`), or
- `from` / `to` as ISO strings (override `since`).

### `GET …/functions`
Function overview for the range.
```json
{ "items": [ {
  "name": "checkout-createOrder", "region": "eu-west-1",
  "invocations": 1234, "errors": 12, "error_rate": 0.0097,
  "cold_starts": 40, "avg_ms": 120.5, "p50_ms": 80.1, "p95_ms": 410.0, "p99_ms": 900.2,
  "last_invoked": "2026-11-14T12:00:00.000Z" | null, "throttles": 31
} ] }
```
`throttles`: requests Lambda rejected in the range (CloudWatch `Throttles`, see `auto-trace.md`, "Throttles"); they never
reached the function. A function that was only throttled in the range is listed with 0 invocations and `last_invoked: null`.

### `GET …/invocations`
Query: `function`, `status` (`ok`|`error`), `q` (free text: matches request ID, trace ID, error message, HTTP path), `limit` (default 50, max 500), `cursor` (opaque; from `next_cursor`).
```json
{ "items": [ {
  "trace_id": "673f1a2b…", "span_id": "…", "ts": "…",
  "function": "checkout-createOrder", "region": "eu-west-1",
  "status": "ok", "duration_ms": 93.2, "cold_start": false,
  "request_id": "…", "trigger": "aws:apigatewayv2",
  "http_method": "POST", "http_path": "/orders", "http_status": 200,
  "error_type": null, "error_message": null, "memory_used_mb": 88,
  "memory_limit_mb": 256, "failure_phase": null, "failure_kind": null, "synthetic": false, "init_duration_ms": null
} ], "next_cursor": "…" | null }
```
Sorted by `ts` descending. Pagination is keyset on `(ts, span_id)`, so workspace-wide pages run across projects
without gaps or repeats.

Failures outside the handler (reported by the Ivy extension from the Lambda Telemetry API, `platform-failures.md`)
have `failure_phase` `init` or `invoke` and a `failure_kind`: `init_failed`, `out_of_memory`, `timed_out` or `crashed`
(labels "Init failed", "Out of memory", "Timed out", "Crashed"; `failureKind()`/`failureLabel()` in `@ivy/spans`).
Tracer-reported timeouts (`error_type` `Timeout`) are `timed_out` too. `synthetic: true` means the extension created
the invocation span itself (the trace has no tracer spans). `request_id` is `""` for an init failure that had no
request. `memory_limit_mb` comes from the `faas.max_memory` resource attribute, `init_duration_ms` is set on cold starts.

### `GET …/traces/:traceId`
All spans of a trace, sorted by start time.
```json
{ "trace_id": "…", "spans": [ {
  "span_id": "…", "parent_span_id": "" ,
  "name": "DynamoDB.GetItem", "kind": "CLIENT", "service": "checkout-createOrder",
  "start": "…", "end": "…", "duration_ms": 12.3,
  "status_code": "OK" | "ERROR" | "UNSET", "status_message": "",
  "attributes": { "rpc.system": "aws-api", "…": "…" },
  "resource": { "service.name": "…", "cloud.region": "…" },
  "events": [ { "ts": "…", "name": "log", "attributes": { "log.severity": "info", "log.message": "…" } } ]
} ] }
```
Attribute values are strings in storage; the API returns them as stored (strings).
Update spans (`ivy.update = true`: Lambda report data the extension sends after the invocation, see
`span-conventions.md`) are merged into the span with the same span ID (`mergeUpdateSpans` in `@ivy/spans`) and never
returned themselves, so `ivy.billed_duration_ms`, `ivy.memory_max_used_mb` and `ivy.memory_size_mb` appear on the
invocation span once the report has arrived.
JSON-valued attributes (`ivy.payload.*`, headers, arrays) are JSON strings for the UI to parse.
404 if not found.

`?format=text` returns `text/plain` instead: the trace as a compact text tree for LLMs (`@ivy/format`, see `mcp.md`).
`detail=summary|normal|full` (default `normal`), `max_tokens` (default 4000, `0` = no limit). 400 for other values.

### `GET …/errors`
Error groups, grouped by fingerprint (function + error type + normalized message).
Query: `function`.
```json
{ "items": [ {
  "fingerprint": "…", "function": "…", "error_type": "TypeError",
  "error_message": "Cannot read properties of undefined (reading 'id')",
  "count": 42, "first_seen": "…", "last_seen": "…", "sample_trace_id": "…", "kind": "error", "failure_kind": null
} ] }
```
`failure_kind` as in `/api/invocations` (from the newest occurrence). Init failures group by function, error type and
the first meaningful log line, e.g. `Runtime.ImportModuleError` + `Error: Cannot find module 'left-pad'`.

Each throttled function also gets one synthetic group: `kind: "throttle"`, `error_type: "Throttled"`,
`fingerprint: "throttled:<region>:<function>"`, `count` = throttles in the range, `sample_trace_id: null` (throttled
requests never reach the function, so there is no trace), `failure_kind: null`. Groups are sorted by count.

### `GET …/stats/timeseries`
Query: `function` (optional), `bucket` (`1m`|`5m`|`15m`|`1h`|`1d`, default picked from range to keep about 100 points or fewer).
Workspace-wide also `project` (slug or ID; 404 when the workspace has no such project), to tell apart a function name
that exists in several projects.
```json
{ "items": [ { "ts": "…", "invocations": 10, "errors": 1, "p95_ms": 300.1, "throttles": 0 } ] }
```

## AWS accounts and auto-trace (`/api/w/:workspace/aws/…`)

Design and flow: `auto-trace.md`. AWS accounts belong to the workspace. **Tracing is opt-in:** connecting an account
traces nothing; functions are listed as `available` until a tag, a manual choice or a rule selects them. Request
bodies are JSON.

Function `state`: `traced`, `available` (supported, not selected), `opted_out` (excluded by the `ivy:trace=false`
tag or a manual exclude), `unsupported` (runtime/package type, or part of Ivy's stack), `conflict` (another exec
wrapper, or 5 layers), `error`, `pending` (waiting for server config, the layer, or readable tags).

### `GET /api/w/:workspace/aws/setup`
Server-side configuration the connect flow needs.
```json
{ "principal_arn": "arn:aws:iam::999999999999:role/ivy" | null, "quick_create": true,
  "events_url": "https://ivy.example.com/api/aws/events" | null, "public_url": "…" | null,
  "ingest_endpoint": "https://ingest.example.com" | null, "layer_sha256": "…" | null,
  "default_region": "us-east-1", "regions": ["us-east-1", "…"], "sync_interval_seconds": 300,
  "issues": ["Set IVY_INGEST_PUBLIC_URL, plus IVY_SECRET_KEY …"] }
```

### `GET /api/w/:workspace/aws/template.yaml`
The CloudFormation template (`text/yaml`) with `account=<connection id>`'s values (trusted principal, external ID,
role name, events URL, and the event secret as a `NoEcho` parameter) filled in as parameter defaults, so it can be
uploaded in the CloudFormation console as is. Needs auth like every workspace route (it contains the event
secret). Without `account` only the trusted principal is filled in. `download=1` adds
`content-disposition: attachment`.

### `POST /api/w/:workspace/aws/accounts` (connect)
Body: `{ "account_id": "123456789012", "name"?: "Production", "regions": ["eu-west-1"], "all_regions"?: false, "stack_region"?: "eu-west-1", "default_project"?: "checkout-prod" }`.
The stack region is added to `regions`. `default_project` (slug or ID) is only the project the UI preselects when
tracing this account's functions. 201 with the account (status `pending`), shaped as below. With the
`publish-cfn-template` hook, its `quick_create_url` opens the CloudFormation quick-create page for the connection's
pre-filled template; without it (or when it fails) `quick_create_url` is null and the UI offers
`template_download_url` plus upload steps. 409 if the
AWS account is already connected to this workspace.

### `GET /api/w/:workspace/aws/accounts`, `GET /api/w/:workspace/aws/accounts/:id` (status)
```json
{ "items": [ {
  "id": "7695fb70-…", "name": "Production", "account_id": "123456789012",
  "role_arn": "arn:aws:iam::123456789012:role/IvyTrace-7695fb70", "external_id": "ivy-…",
  "stack_name": "ivy-trace-7695fb70", "stack_region": "eu-west-1",
  "default_project_id": "prj_…" | null, "default_project": "checkout-prod" | null,
  "regions": ["eu-west-1"], "all_regions": false,
  "status": "pending" | "connected" | "error", "error": "…" | null,
  "created_at": "…", "verified_at": "…" | null, "last_sync_at": "…" | null, "reviewed_at": "…" | null, "syncing": false,
  "throttle_metrics": true, "throttle_status": "ok" | "missing_permission" | "error" | null,
  "counts": { "traced": 12, "available": 30, "opted_out": 1, "unsupported": 3, "conflict": 1, "error": 0, "pending": 0, "total": 47, "new": 4 },
  "quick_create_url": "https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?templateURL=…&stackName=…" | null,
  "quick_create_error": "Publishing the template failed: … Download the template and upload it in the CloudFormation console instead." | null,
  "template_download_url": "/api/w/acme/aws/template.yaml?account=…&download=1"
} ] }
```
`quick_create_url` never carries parameters (no external ID or secret in the link); everything is in the template
behind `templateURL`. `quick_create_error` is set when the hook exists but failed.
`counts.new`: available functions first seen after `reviewed_at` (the UI's "new untraced functions" badge).
`error` on a connected account lists per-region sync errors, one per line. `throttle_status` is `null` until the first
throttle poll; `missing_permission` means the stack's role predates `cloudwatch:GetMetricData`. `POST` accepts
`"throttle_metrics"?: true`.

### `PATCH /api/w/:workspace/aws/accounts/:id`
Body: any of `name`, `regions`, `all_regions`, `default_project` (slug, ID or null), `throttle_metrics` (boolean), `reviewed`
(`true` sets `reviewed_at` to now, clearing `counts.new`). Changing regions starts a sync for connected accounts. Returns the account.

### `POST /api/w/:workspace/aws/accounts/:id/verify`
Tries `AssumeRole`. `{ "verified": true|false, "account": {…} }`; on success the account becomes `connected` and the
first sync starts (it lists functions; it traces only what tags, manual choices or rules select).

### `POST /api/w/:workspace/aws/accounts/:id/sync`
202 `{ "started": true }`; the sync runs in the background (`?wait=1` waits). 409 while pending.

### `DELETE /api/w/:workspace/aws/accounts/:id?detach=true|false`
Removes the layer from all functions first unless `detach=false` (or the account is pending), then deletes the connection.
`{ "deleted": true, "detached": true, "detach_errors": ["eu-west-1/fn: …"] }`.

### Function objects

```json
{ "account_id": "123456789012", "region": "eu-west-1", "name": "checkout-prod-createOrder",
  "arn": "arn:aws:lambda:…", "runtime": "nodejs22.x",
  "stack": "checkout-prod" | null, "tags": { "aws:cloudformation:stack-name": "checkout-prod", "team": "core" },
  "last_modified": "2026-11-10T09:12:44.000+0000" | null,
  "state": "traced", "reason": "…" | null,
  "project_id": "prj_…" | null, "project": "checkout-prod" | null,
  "source": "tag" | "manual" | "rule" | null, "rule_id": "rul_…" | null,
  "manual": { "mode": "trace" | "exclude", "project_id": "prj_…" | null, "project": "…" | null } | null,
  "new": false, "first_seen_at": "…", "updated_at": "…" }
```
`project`/`project_id`: where the function sends spans (when the decision is to trace). `source`: what decided it.
`stack`: the `aws:cloudformation:stack-name` tag (Serverless Framework, SAM, CDK and SST all set it). Function data
reflects the last sync.

### `GET /api/w/:workspace/aws/functions`
Every known function, flat. Query: `account` (12-digit ID), `project` (slug or ID: functions sending to it), `state`.
`{ "items": [ <function> ] }`

### `GET /api/w/:workspace/aws/accounts/:id/functions` (grouped by stack)
```json
{ "groups": [ {
  "stack": "checkout-prod", "region": "eu-west-1",
  "counts": { "total": 8, "traced": 8, "available": 0, "new": 0 },
  "rule": { "id": "rul_…", "project_id": "prj_…", "project": "checkout-prod", "enabled": true } | null,
  "suggested_project": "checkout-prod",
  "functions": [ <function> ]
}, {
  "stack": null, "region": null,
  "counts": { "total": 3, "traced": 0, "available": 3, "new": 1 }, "rule": null, "suggested_project": null,
  "functions": [ <function> ]
} ] }
```
One group per (stack, region), sorted by stack name; functions without a stack form the last group (`stack: null`,
"Other functions"). `rule` is the first rule that matches exactly this stack (`matcher` with only `stack`, and
optionally `account_id`/`region`). `suggested_project` is the stack name as a slug, for the "Trace stack" dialog.

### `PUT /api/w/:workspace/aws/functions/:accountId/:region/:name` (manual choice)
Body `{ "mode": "trace", "project"?: "checkout-prod" }`, `{ "mode": "exclude" }`, or `{ "mode": "rules" }` (clear the
manual choice: follow tags and rules again). `project` defaults to the workspace's default project. Stores the
choice, then applies it to that function right away:
`{ "applied": true, "error": null, "function": <function> | null }`. If applying fails the choice is kept and the next
sync retries. 404 if the AWS account isn't connected to the workspace.

### `POST /api/w/:workspace/aws/functions/bulk` ("Trace selected")
Body `{ "functions": [ { "account_id": "123456789012", "region": "eu-west-1", "name": "fn-a" } ], "mode": "trace" | "exclude" | "rules", "project"?: "…" }`
(at most 500). Stores the choices and starts a sync of the affected accounts: 202 `{ "updated": 2 }`.

### Rules

A rule selects functions for tracing and names their project. Rules are evaluated in order; the first **enabled**
rule that matches wins. A function no rule matches stays `available` (and is detached if it was traced).

Precedence per function:
1. Tags: `ivy:trace=false` never traces; `ivy:trace=true` traces.
2. The manual choice (`PUT …/functions/…`): trace into a project, or exclude.
3. Rules, in order.
4. Otherwise not traced.

Whenever a function is traced, an `ivy:project=<slug>` tag naming an active project of the workspace picks the
project; otherwise the manual choice's project, the rule's project, or (for `ivy:trace=true` alone) the workspace's
default project.

Matcher: every non-empty field must match.
```json
{ "account_id"?: "123456789012", "region"?: "eu-west-1", "stack"?: "checkout-*", "name"?: "orders-*", "tag"?: "team=core" }
```
`stack` and `name` are globs (`*` any run of characters, `?` one character; no wildcard = exact; `orders-*` is a
prefix match). `tag` is `key=value` (the value may be a glob) or `key` (present). At least one field is required;
`{ "name": "*" }` matches every function.

- `GET /api/w/:workspace/aws/rules` →
  `{ "items": [ { "id": "rul_…", "position": 0, "matcher": { "account_id": null, "region": null, "stack": "checkout-prod", "name": null, "tag": null }, "project_id": "prj_…", "project": "checkout-prod", "enabled": true, "created_at": "…" } ] }`
- `POST /api/w/:workspace/aws/rules`, body
  `{ "matcher": { "stack": "checkout-prod" }, "project"?: "checkout-prod", "new_project"?: { "name": "Checkout (prod)", "slug"?: "checkout-prod" }, "enabled"?: true, "position"?: 0 }`
  → 201 `{ "rule": <rule>, "project": <project> }`. Give `project` (slug or ID; default: the workspace default
  project) or `new_project` (creates the project first). Appended last unless `position` is given. Starts a sync of
  every connected account, so matching functions are traced within seconds.
- `PATCH /api/w/:workspace/aws/rules/:id`, body: any of `matcher`, `project`, `enabled`, `position` → the rule; re-syncs.
- `DELETE /api/w/:workspace/aws/rules/:id` → `{ "deleted": true }`; re-syncs (functions only it selected are detached).
- `PUT /api/w/:workspace/aws/rules/order`, body `{ "order": ["rul_b", "rul_a"] }` → `{ "items": [ <rule> ] }`; re-syncs.

### `POST /api/w/:workspace/aws/rules/dry-run`
Which functions a matcher selects, and what adding it as a rule (last) would do. Nothing is stored. Used by the UI's
live preview and by agents before creating a rule.
Body `{ "matcher": { "stack": "checkout-prod" }, "project"?: "checkout-prod" }` (an unknown `project` is
allowed here and treated as a new project).
```json
{ "count": 8,
  "summary": { "trace": 7, "unchanged": 0, "excluded": 1, "other": 0, "unsupported": 0 },
  "items": [ { "function": <function>, "outcome": "trace" | "unchanged" | "excluded" | "other" | "unsupported", "project": "checkout-prod" | null } ] }
```
`trace`: would start tracing (or move) into the project; `unchanged`: already traced there; `excluded`: a tag or
manual choice keeps it untraced; `other`: a tag, manual choice or earlier rule sends it elsewhere; `unsupported`:
can't be traced. Matches are against the functions found by each account's last sync.

### `POST /api/aws/events`
EventBridge API destination target, authenticated with the `x-ivy-event-secret` header (per connection), not user
auth, so it is not under a workspace. Syncs the event's region. 202, or 401/403.

## Hosting hooks

Deployment-specific behaviour is added with executable hooks in `IVY_HOOKS_DIR`, not with API calls. The normative
contract (envelope, kinds, timeouts, environment, payload types) is `hooks.md`. Current hooks:

| hook | kind | data → result | effect on the API |
|---|---|---|---|
| `publish-cfn-template` | provider | `{ workspace, connection, template }` → `{ url, expires_at? }` | `aws.quick_create` in `/api/config`; `quick_create_url` / `quick_create_error` on accounts |
| `on-workspace-created` | notification | `{ workspace, owner }` | none (e.g. hosted applies plan limits) |
| `on-member-joined` | notification | `{ workspace, member, invitation_id, invited_by }` | none |
| `on-aws-account-connected` | notification | `{ workspace, connection }` | none |

Public Ivy has no plans or limits; a workspace without a limits record is unlimited.

## OpenAPI

### `GET /api/openapi.json`
This contract as an OpenAPI 3.1 document (hand-maintained in `src/lib/openapi/`; a test checks it lists exactly the
routes the app serves). Security scheme: OIDC bearer token, off on self-hosted setups without OIDC.

### `GET /api/docs`
API reference page (Scalar, loaded from its CDN).

## MCP

### `POST /mcp`
Remote MCP server (Streamable HTTP, stateless, JSON responses) with the tools `list_workspaces`,
`find_failing_invocations`, `search_invocations`, `list_error_groups`, `get_trace_summary`, `compare_invocations`,
and the MCP Apps tools `render_waterfall` and `render_graph` (views served as `ui://ivy/*.html` resources). Tools
cover every workspace the caller is a member of, one tenant-scoped read per workspace, unless given `workspace`;
an optional `project` (slug or ID) narrows them to that project. Without it they read through the same workspace-wide
data functions as the routes above (`lib/data/*` with an all-projects scope), so results match the dashboard's
"All projects", and each line is labelled `[workspace/project]`.
With OIDC configured it needs a bearer token whose audience is `IVY_MCP_RESOURCE` (MCP clients registered under
`IVY_OIDC_CLIENT_ID` are accepted there), and answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`
otherwise. Details: `mcp.md`.

### `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp`
RFC 9728 protected resource metadata of the MCP endpoint (only when OIDC is configured; 404 otherwise).

## Ingest (separate service, port 4318)

Not part of the API process: the ingest router (`tenancy.md`) serves OTLP/HTTP.

### `POST /v1/traces`
OTLP/HTTP `ExportTraceServiceRequest`, `application/x-protobuf` or `application/json`, optionally
`content-encoding: gzip`/`deflate`. Authenticated with `Authorization: Bearer <key>` or `x-api-key: <key>` (a
project's ingest key). The spans are stored under the key's workspace and project; `ivy.tenant_id` and
`ivy.project_id` sent by the client are overwritten. Answers as OTLP/HTTP: the collector's response on success;
400, 401 (also for keys of archived projects), 413, 415, 429 (`Retry-After`) or 503 (`Retry-After`) with a
`google.rpc.Status` body otherwise. `/v1/logs` and `/v1/metrics` are 404; there is no gRPC.
A workspace over a monthly trace quota with `over_quota: block` gets 429, `Retry-After: 300` (or until the month
ends) and `{"code":8,"message":"Monthly trace quota reached (…). … Upgrade at https://…/w/<slug>/settings/usage."}`
(`limits.md`).

## Internal admin API (separate, not under `/api`)

For the operator's billing service; not part of the public contract and not in the OpenAPI document. Served by the
API process at `/internal/*`, which only exists when `IVY_INTERNAL_API_TOKEN` is set (≥ 32 characters; otherwise every
`/internal/*` path is 404). Every call needs `Authorization: Bearer $IVY_INTERNAL_API_TOKEN`: 401 otherwise. OIDC and
workspace membership don't apply. Keep the prefix off public proxies (ivytrace.dev routes only `/api/*` and the app's
paths to the API). Errors are `{ "error": "…" }` (400 invalid body or month, 404 unknown workspace).

`:id` is the workspace (tenant) ID. `month` is `YYYY-MM` (UTC), default the current month. Usage objects are as in
`GET /api/w/:workspace/usage`, plus the workspace's `name` and `slug`; the count is never cached here.

### `GET /internal/workspaces?month=&limits=unset`
Every workspace with its traces in the month and its limits. `limits=unset` keeps only workspaces without a limits
row (for a reconcile job that gives new workspaces a free tier).
```json
{ "month": "2026-11", "items": [ { "name": "Acme", "slug": "acme", "workspace": "ten_…", "month": "2026-11", "period": { … },
  "traces": 2481904, "limits": { "plan": "Pro", "monthly_trace_quota": 100000, "over_quota": "allow", "source": "workspace" },
  "blocked": false } ] }
```

### `GET /internal/workspaces/:id?month=`
One workspace's usage object.

### `PUT /internal/workspaces/:id/limits`
Body `{ "plan": "Free", "monthly_trace_quota": 100000 | null, "over_quota": "block" | "allow" }` (all optional:
`""`, `null` = unlimited, `allow`). Replaces the workspace's limits. The ingest routers pick it up within
`IVY_QUOTA_REFRESH_SECONDS`.
`{ "workspace": "ten_…", "limits": { …, "source": "workspace" }, "updated_at": "…" }`

### `DELETE /internal/workspaces/:id/limits`
Removes the row: the workspace is unlimited again. `{ "workspace": "ten_…", "limits": { …, "source": "unset" } }`

### `GET /internal/workspaces/:id/members`
`{ "workspace": "ten_…", "items": [ { "sub": "idn_…", "email": "erin@example.com", "role": "owner" | "member" } ] }`
(from `ivy_control.tenant_members`).

### `GET /health`
`{ "ok": true }`
