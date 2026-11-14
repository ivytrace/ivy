# Workspaces and projects

How Ivy groups people, AWS accounts and data. The API contract is `api.md`; storage details are in `storage.md` and
`tenancy.md`; how functions get into projects is in `auto-trace.md`.

## Model

```
User (OIDC subject) ──member of──▶ Workspace ──has──▶ Projects ──own──▶ ingest keys, functions' spans
                                     │
                                     ├─ members (owner | member), invitations
                                     ├─ AWS accounts, auto-trace rules
                                     └─ shard (cell); later: billing, quotas
```

- **Workspace** = the existing *tenant* (`ivy_control.tenants`): ID `ten_…` (`default` for self-hosted), a `slug`
  unique across workspaces (in URLs) and a `name`. It owns members, AWS connections and rules, and the
  shard holding its spans. Later also billing and quotas.
- **Project** (`ivy_control.projects`): ID `prj_…`, `slug` unique within the workspace, `name`, `archived`. It owns
  ingest keys (and later alert rules and dashboards). **Every span, and so every function, belongs to exactly one
  project**: the project of the key it was sent with.
- **Environments are separate projects** (`checkout-prod`, `checkout-staging`), not a filter. A project is usually one
  app in one environment, which is also what one CloudFormation stack usually is, so auto-trace's stack rules map
  stacks onto projects.
- Every workspace has a **default project** from creation (slug `default`, renamable, not archivable). Its ID is
  derived from the tenant ID (`prj_` + 21 hex chars of `sha256('ivy-default-project:' + tenant)`), so every process
  agrees on it without a lookup, and creating it is idempotent.
- **Members** (`tenant_members`): `owner` or `member`. A workspace always keeps one owner.
- **Invitations** (`invitations`): ID `inv_…`, email, role, `sha256(token)`, inviter, `expires_at` (7 days),
  `accepted_at`/`accepted_by`, `revoked_at`.

## Decisions

### URLs carry workspace and project as path segments

API: `/api/w/:workspace/…` and `/api/w/:workspace/p/:project/…`. UI: `/w/:workspace/:project/functions`,
`/w/:workspace/:project/traces/:id`, `/w/:workspace/settings/…`. Path segments rather than query params, because the
membership check and project resolution then run once in middleware for the whole prefix (a route can't forget them),
API and UI URLs line up, and agents can build URLs from two slugs. Both accept slugs or IDs, so links built from IDs
survive renames. The project segment `all` in the UI means "all projects of this workspace" (functions, invocations,
errors and timeseries exist workspace-wide in the API; a trace needs its project), which is why `all` and `settings`
are reserved project slugs.

### "All projects" is a full scope, except for single traces

Functions (with its charts), Invocations and Errors work under `all`, through the workspace-wide routes. Rows carry
their project's slug and link into that project (trace, function, project), because a trace lives in exactly one
project. A trace URL under `all` (old link, ⌘K) looks up the trace's invocation in the workspace-wide list (`q` matches
trace IDs exactly) and redirects to its project. The keyset cursor `(ts, span_id)` stays as it is across projects: a
span ID is 64 random bits, so two projects sharing one at the same millisecond isn't a practical concern. The MCP
tools use the same data functions without a project, so an agent and the dashboard see the same rows.

### Slugs are generated from names and hidden; URLs stay stable when renaming

Creating a workspace or project takes a name only. The slug comes from the name (`slugify`: lower case, accents
folded to ASCII, other characters → `-`, dashes collapsed and trimmed, at most 40 characters, `workspace`/`project`
when nothing is left). Collisions get `-2`, `-3`, … (workspace slugs are unique globally, project slugs within their
workspace). Renaming changes only the name; the slug, and so every URL, stays. Settings show the URL read-only with a
"Change URL" action under Advanced.

ClickHouse has no unique constraints, so `claimSlug` (`lib/tenancy/slugs.ts`) makes allocation safe: claims of one
scope run one at a time in a process, and after writing, a record checks that it is the oldest holder of its slug
(`created_at`, then ID); if another process wrote the same slug first, the newer record takes the next candidate. A
test runs two claims as separate "processes" and checks they end up with `acme` and `acme-2`.

### Membership is checked on every request, and non-members get 404

`workspaceContext` resolves the workspace and the caller's membership for each request (memberships are cached for
5 s per user in-process; removing someone takes effect within that). A workspace that exists but the caller isn't
in answers exactly like one that doesn't exist: 404 `Workspace not found`, so slugs can't be probed. Roles: owners
can rename/delete the workspace and manage members and invitations; members can do everything else (data, projects,
keys, AWS). Owner checks are `requireOwner(c)` in the routes that need it.

### The query guard knows projects

Span tables are keyed `(tenant, project, …)`. `scopedQuery` refuses SQL on `otel_traces`, `invocations` or
`invocations_hourly` without a `{project:String}` filter per reference, unless the scope says `allProjects: true`
explicitly; and the routes that may do that are mounted with `allProjects()`. Row policies on the project
(`SQL_ivy_project`) back it up. See `tenancy.md`, "Guards".

### Ingest stamps the project server-side

The router resolves key → tenant **and** project (keys from before projects belong to the default project; keys of
archived or missing projects are rejected with 401) and forwards `x-ivy-project` next to `x-ivy-tenant`. The collector
deletes any client-sent `ivy.project_id` and inserts the header's value, exactly like the tenant, and drops spans
without either. `otel_traces.ProjectId` defaults from that attribute. Verified on the pinned collector (0.165.0): a
forged `ivy.project_id` (and `ivy.tenant_id`) is overwritten, and a request without the project header stores nothing.

### Single-workspace mode hides workspace management

With auth off, or OIDC with `IVY_SINGLE_TENANT` unset/`1` (self-hosted default), there is exactly one workspace,
`default`, and everyone using the install owns it: access is decided by who can reach Ivy or sign in at the IdP.
Creating/deleting workspaces, members and invitations answer 403 and the UI hides them (`GET /api/config` →
`workspaces.multi: false`). Renaming the workspace (not its slug), projects, keys and AWS work as usual. Hosted runs
with `IVY_SINGLE_TENANT=0`.

### No passwords

Users exist only as OIDC subjects; there are no Ivy passwords or local accounts. Without OIDC there are no users at
all (and no invitations).

## Flows

**First sign-in (multi-workspace).** `GET /api/workspaces` for a user without memberships creates a personal workspace
(ID derived from the subject, so concurrent first requests converge), with them as owner and a default project;
`on-workspace-created` fires. The UI's first-run wizard then names the workspace and the first project and connects
AWS or hands out an ingest key (`ui.md`).

**Create a workspace.** `POST /api/workspaces { name, slug? }`: a free slug from the name, the default project, the
caller as owner, `on-workspace-created`.

**Delete a workspace.** Owners only, `?confirm=<slug>`, refused while AWS accounts are connected (so no function keeps
sending with a dead key) and for `default`. Revokes all keys, removes members and pending invitations, marks the tenant
deleted. Spans stay until retention removes them.

**Invite.** An owner posts an email and role. Ivy creates a 32-byte random token, stores only its sha256, and returns
the link `https://<host>/invite/<token>` once (host: `IVY_PUBLIC_URL`, else the dashboard's origin) for the UI to show
and copy. With `IVY_SMTP_URL` and `IVY_EMAIL_FROM` set it also emails the link (nodemailer; hosted uses SES SMTP with a
sender on the verified ivytrace.dev domain). A new invitation for the same email revokes the pending one.

**Accept.** `/invite/<token>` in the UI requires sign-in (it goes through `/login` and comes back). The page shows the
workspace and calls `POST /api/invitations/:token/accept`. Ivy accepts only when:
- the token matches a pending invitation (otherwise 410: already used, revoked or expired; 404: unknown);
- the signed-in user's email equals the invited email, case-insensitively;
- the identity provider says that email is verified (`email_verified`). Both come from the access token when it has
  `email` and `email_verified`, otherwise from the provider's userinfo endpoint called with the same access token
  (some providers' access tokens carry no email).

Otherwise it answers 403 with a message saying which (wrong account, or verify your email first), shown as is in the
UI. Success marks the invitation accepted (single use) and adds the membership; `on-member-joined` fires. Two
concurrent accepts by the same user write the same membership row, so they're harmless; nobody else can use the token
because the email must match.

**Projects.** Create (slug from the name unless given), rename/re-slug, archive/unarchive. Archiving keeps the data
readable, stops the project's keys at the router (within the key cache TTL of a minute), refuses new keys, and
re-syncs AWS so rules pointing at it stop tracing into it.

**Keys.** Per project: create (the key is shown once), list (prefix only), revoke. The auto-trace key of a project is
listed as `auto-trace` and can be revoked to rotate it.

## Hosted routing

The app's own paths that CloudFront must send to the app (in addition to those in `auth.md`): `/w/*`, `/invite/*` and
`/welcome*`. `auth.md`, "What hosted CloudFront needs", has the full list.

## Configuration

| variable | default | |
|---|---|---|
| `IVY_SINGLE_TENANT` | `1` | `0` (with OIDC) turns on multiple workspaces, members and invitations |
| `IVY_SMTP_URL` | | SMTP URL for invitation emails, e.g. `smtps://USER:PASS@email-smtp.eu-west-1.amazonaws.com:465` |
| `IVY_EMAIL_FROM` | | sender, e.g. `Ivy <noreply@ivytrace.dev>`; both are needed to send |
| `IVY_PUBLIC_URL` | | base of invite links (else the request's origin) |
| `IVY_SECRET_KEY` | | needed for auto-trace into any project but the default workspace's default project |

## Verification

- Unit/route tests: `routes/workspaces/workspaces.test.ts` (with a local OIDC provider in `lib/auth/testing.ts`:
  personal workspace, create/rename/delete with confirmation, 404 for non-members by slug and ID, owner-only routes,
  last owner, invitations: email sent, link format, token not stored, accept once, reuse 410, wrong email 403,
  unverified email 403 from the token and from userinfo, expired, revoked, replaced, single-workspace mode),
  `lib/tenancy/members.test.ts`, `tenants.test.ts` (default projects, slugs, old keys → default project, per-project
  keys and auto-trace keys), `routes/tenant-scope.test.ts` and `lib/clickhouse/scoped.test.ts` (project guard; workspace-wide invocations and
  timeseries: tenant bound, no project, items labelled with their project, a cursor page across projects, `project`
  narrowing, 404 for another workspace without any query),
  `lib/ingest/router.test.ts` (`x-ivy-project`, old keys, archived/missing projects).
- Schema: a ClickHouse volume created with the previous schema was refused by the new `init.sh` with the reset
  instructions; after `reset.sql` the new `init.sh` created all 14 tables and ran again as a no-op. (A data-preserving
  in-place rebuild was also built and verified first, then dropped in favour of the reset; see `storage.md`.)
- End to end on a compose stack with alternate ports (`ivy-e2e`: API :13000, ingest :14318, ClickHouse :18123), OIDC
  on in multi-workspace mode against a throwaway provider (`pnpm --filter @ivy/api e2e:workspaces`): two users, two
  workspaces, two projects each, a key per project, one invocation per project sent through the ingest router with
  forged `ivy.tenant_id`/`ivy.project_id`. Each project's functions/invocations/traces showed only its own data, a
  trace was 404 under the sibling project, workspace-wide functions covered both projects with project slugs, forged
  attributes were overwritten, the other user got 404 on the workspace (by slug and ID) until invited, the invite was
  accepted once (second use 410), a member couldn't rename the workspace, an archived project refused new keys.

## Gaps

- An explicitly chosen slug ("Change URL", or `slug` in a create body) is checked before writing but not re-verified
  afterwards, so two such edits to the same slug at the same instant could both succeed; lookups then use the older
  holder.
- Memberships are cached for 5 s per API process, so a removed member keeps access for up to 5 s (another process
  doesn't see in-process invalidation).
- Notification hooks are at-most-once; there is no outbox.
- No transfer of a project between workspaces, and no merging of projects; data stays where it was ingested.
