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
- Every workspace has a **default project**: where keys without a project and functions traced without a project go.
  It is a movable designation (`tenants.default_project_id`), not a fixed project; see "The default project is a
  designation". The first one is created with the workspace (slug `default`, renamable) with an ID derived from the
  tenant ID (`prj_` + 21 hex chars of `sha256('ivy-default-project:' + tenant)`), so creating it is idempotent and a
  tenant whose `default_project_id` is empty (never moved, or from before the column) falls back to it.
- **Members** (`tenant_members`): `owner` or `member`. A workspace always keeps one owner.
- **Invitations** (`invitations`): ID `inv_…`, email, role, `sha256(token)`, inviter, `expires_at` (7 days),
  `accepted_at`/`accepted_by`, `revoked_at`.

## Decisions

### URLs carry workspace and project as path segments

API: `/api/w/:workspace/…` and `/api/w/:workspace/p/:project/…`. UI: `/w/:workspace/:project/functions`,
`/w/:workspace/:project/traces/:id`, `/w/:workspace/settings/…`. Path segments rather than query params, because the
membership check and project resolution then run once in middleware for the whole prefix (a route can't forget them),
API and UI URLs line up, and agents can build URLs from two slugs. Both accept slugs or IDs, so links built from IDs
survive renames. The project segment `all` in the UI means "all projects of this workspace" (the function overview and
errors exist workspace-wide in the API; invocations and traces don't, they need a project), which is why `all` and
`settings` are reserved project slugs.

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

### The default project is a designation

Users asked to delete the default project. Archiving is the closest thing Ivy has to deleting a project (data stays
until retention), so the default project can now be archived like any other, and "default" moved from a fixed derived
ID to a column on the tenant, `default_project_id` (added with `ADD COLUMN IF NOT EXISTS`; '' means the derived ID).
One helper, `workspaceDefaultProject(tenant)` (`lib/tenancy/ids.ts`), resolves it, and `defaultProjectOf(tenantId)`
(`projects.ts`) reads it fresh from the control database. Everything that used the derived ID as a fallback uses it:

- keys with an empty `project_id` (keys from before projects and the `IVY_INGEST_API_KEY` bootstrap key, which is now
  written without a project so it follows the default) in `findKeyByHash`, the router's key cache and the key routes;
- auto-trace: `ivy:trace=true` and manual "trace" without a project (`loadAssigner`, the rule dry run), and the
  auto-trace key when no project is named;
- `targetProject` when a rule or manual choice gives no project. That resolves the default **when the rule is
  saved** and stores its ID, so an existing rule keeps its project when the default moves later (and stops matching if
  that project is archived, like any rule pointing at an archived project);
- throttles of traced functions with an empty project.

Changing it: `PATCH /api/w/:workspace { default_project }` (any member, since members manage projects; name and slug
stay owner-only), or archiving the default project. Archiving the default with `new_default` (ID or slug) makes that
the default, without it the oldest remaining active project. Archiving the last active project is refused with 409
"A workspace needs at least one project".

ClickHouse has no transactions, so archiving the default writes the tenant row (new default) **before** the project
row (archived). A failure in between leaves the old default still active and no longer the default, which is
harmless; the other order could leave a default that is archived, which would reject every key without a project.
Writes to the tenant row re-read it first (`updateWorkspace`), so a rename doesn't put back an older default.

After the move, keys without a project send to the new default within the router's one-minute key cache, and keys
created explicitly for the archived project are rejected (401), as for any archived project. Functions traced into
the old default by tag or manual choice without a project move to the new default at the next sync (the archive
triggers one); functions whose rule names the old project stop being traced into it.

### Ingest stamps the project server-side

The router resolves key → tenant **and** project (keys without a project belong to the workspace's current default
project; keys of archived or missing projects are rejected with 401) and forwards `x-ivy-project` next to `x-ivy-tenant`. The collector
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

**Projects.** Create (slug from the name unless given), rename/re-slug, archive/unarchive, make default. Archiving
keeps the data readable, stops the project's keys at the router (within the key cache TTL of a minute), refuses new
keys, and re-syncs AWS so rules pointing at it stop tracing into it. Archiving the default project moves the default
first (above). Settings → Projects shows "· default" next to the default, a "Make default" action on the others, and
for the default an archive dialog with a select for the new default that spells out what moves and what stops.

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
  keys and auto-trace keys), `routes/projects/projects.test.ts` (archiving the default with and without
  `new_default`, bad `new_default`, the last project, `default_project` on the workspace, and what follows the
  default: empty-project keys through the key cache, the bootstrap key, auto-trace keys, `targetProject`, the
  assigner), `lib/aws/throttles.test.ts` (throttles under the moved default), the UI's
  `components/workspaces/archive-default.test.tsx` (the archive dialog) and `lib/mock/server.test.ts` (the mock API
  mirrors it), `routes/tenant-scope.test.ts` and `lib/clickhouse/scoped.test.ts` (project guard),
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
