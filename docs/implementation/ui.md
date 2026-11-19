# UI (`packages/ui`)

React dashboard, started from an earlier Lambda tracing dashboard, which served as a visual reference. Most of the
code was rewritten.

## Stack

Vite 8, React 19, TypeScript strict, Tailwind v3 with shadcn/ui (Radix) components, react-router 7,
SWR, Recharts 2, React Flow (`@xyflow/react`) and dagre for the service graph, `react-json-tree` for payloads.
Vitest, with tests next to their sources.

## Commands

| | |
|---|---|
| `pnpm --filter @ivy/ui dev` | Vite on :5173. `/api` is proxied to `http://localhost:3000` (`IVY_API_URL` overrides) |
| `pnpm --filter @ivy/ui dev:mock` | Same, but `/api` is answered by an in-process mock (no API needed) |
| `pnpm --filter @ivy/ui build` | Static build in `packages/ui/dist`, served by the API |
| `pnpm --filter @ivy/ui test` / `typecheck` | Vitest / `tsc --noEmit` |

The mock (`src/lib/mock/`) is a Vite middleware plugin, enabled only when `VITE_MOCK=1`. It serves the whole API in
`api.md` and keeps state while the dev server runs (`server.ts` routes, `workspaces.ts` control plane, `aws.ts` AWS
accounts and rules, `fixtures.ts` span data):

- Two workspaces in multi-workspace mode: `acme` (you own it; projects `checkout-prod`, `checkout-staging`,
  `billing-api-prod`, `billing-api-staging`, `support-api-prod` and an archived one; three members, a pending invitation, ingest
  keys; `ops-healthcheck` is tagged `ivy:trace=true` without `ivy:project`, so it shows "Needs a project") and
  `side-project` (you're a member; no projects yet, so it opens the quick-start wizard).
- Span data: a week of invocations of five functions (one, `support-answerTicket` in `support-api-prod`, an AI SDK support bot) spread over the `acme` projects (`projectOfInvocation` in `server.ts`; a quarter of `checkout-createOrder` runs come from `checkout-staging`, so "All projects" shows one name in two projects), with
- Span data: a week of invocations of five functions (one, `support-answerTicket` in `support-api-prod`, an AI SDK support bot; plus `checkout-importOrders`, an import worker with collapsed calls and omitted spans) spread over the `acme` projects (`PROJECT_OF` in `server.ts`), with
  filters, `since`/`from`/`to`, cursor pagination, error groups, timeseries buckets, and full traces with DynamoDB, S3,
  SQS, SNS, EventBridge, SES, Lambda, Secrets Manager and fetch spans, logs and exceptions. Other workspaces start empty
  and "receive" a first trace 6 s after a rule or an ingest key is created there, so the wizard's last step completes.
- AWS (`acme`): two connected accounts with CloudFormation stacks (`checkout-prod`, `billing-api-prod`,
  `billing-api-staging`, `checkout-staging`, `support-api-prod`, `billing-dev`), stackless functions, every state (traced, available,
  excluded by tag or by hand, unsupported, conflict, error, pending) and new ones; three rules (two stack rules, one
  disabled tag rule) and a manual choice. The mock applies the API's precedence (tags, manual choice, rules), so rules,
  dry runs and per-function choices behave like the real thing. New connections verify 8 s after they're created and
  list a `my-app-prod` stack.
- `VITE_MOCK_EMPTY=1`: one workspace (`personal`) without data or accounts, i.e. the quick-start wizard.
  `VITE_MOCK_NO_TEMPLATE=1`: no one-click quick-create links (`quick_create: false`), so the connect flow shows the
  template download.

`server.test.ts` checks the mock against the contract.

## Layout

```
src/lib/api/       client.ts (fetch + URL building), hooks.ts (SWR hooks per endpoint), aws.ts + workspaces.ts (mutations), types.ts
src/lib/links/     links.ts (route builders, scope parsing, legacy redirects, last-used scope), use-scope.ts (scope of the URL)
src/lib/welcome/   quick-start wizard: URL state, workspace name suggestion, "seen" flags
src/lib/spans/     services.ts (span → service rendering), tree.ts (waterfall), graph.ts (service graph)
src/lib/mock/      mock server for dev:mock
src/lib/utils/     cn, formatting, slugify
src/components/    layout/ (header, scope switcher), aws/ (connect, function picker, rules, trace dialog), workspaces/
                   (onboarding, name/slug dialog, key display), common/, stats/, trace/, tables/, ui/ (shadcn)
src/routes/        functions/, invocations/, traces/, errors/, settings/, invite/, welcome/, scope/ (redirects), auth/
```

## Workspaces, projects and URLs

Everything lives under a workspace and, for data, a project (`workspaces-projects.md`):

| route | |
|---|---|
| `/w/:workspace/:project/functions`, `…/invocations`, `…/errors`, `…/traces/:traceId` | data pages of a project |
| `/w/:workspace/all/functions`, `…/all/invocations`, `…/all/errors` | every project of the workspace (charts included); rows have a quiet Project column and link into their own project (`rowScope`). `/w/:workspace/all/traces/:id` finds the trace's project and redirects there |
| `/w/:workspace` | the last-used project of that workspace, else All projects |
| `/w/:workspace/settings/general` · `members` · `projects` · `aws` · `aws/:id` · `usage` · `alerts/:project` · `notifications` | workspace settings |
| `/invite/:token` | accept an invitation (signed in, outside the layout) |
| `/welcome/:step?ws=&project=&account=&from=&mode=` | the first-run quick start (signed in, outside the layout) |

- The scope comes from the URL (`parseScope`, `useScope`); the API hooks build `/api/w/:ws/p/:project/…` or
  `/api/w/:ws/…` from it. Pages outside `/w/…` (the wizard) set it with `ScopeProvider`.
- The last-used workspace, and the last-used project per workspace, are kept in localStorage (`ivy.lastScope`:
  `{ workspace, project, projects: { <workspace>: <project> } }`, in try/catch; the older `{ workspace, project }`
  still reads). `all` is a valid last choice.
- **All projects is the default selection**: without a remembered project for the workspace (first visit, a new
  workspace, cleared storage, or the remembered project was archived), `pickProject` returns `all`. That covers the
  post-login redirect (`/` → `LegacyRedirect`), switching workspace (`/w/:workspace` → `WorkspaceIndex`), the old
  routes, and the header's and ⌘K's links on settings pages (`useNavScope`). (Workspaces have no default project.)
- Old links keep working: `/`, `/functions`, `/invocations`, `/errors`, `/traces/:id`, `/settings`, `/settings/aws`,
  `/settings/aws/:id`, `/settings/notifications` and `/settings/digest` redirect to the same page in the last-used workspace and project (else the first workspace from
  `GET /api/workspaces` and All projects), keeping the query string and hash (`legacyTarget`, unit-tested).
- Merged settings pages keep their URLs: `/w/:workspace/settings/digest` redirects to `…/settings/notifications`
  (`routes/settings/redirects.ts`, a loader redirect so it is tested with a memory router).
- Routing behind a shared domain: `/w/*`, `/invite/*` and `/welcome/*` are app paths (`auth.md`).

**Header.** A `Workspace / Project ▾` breadcrumb next to the logo with a popover on each part: the workspaces (plus
"Create workspace" in multi-workspace mode, and "Workspace settings"), and the projects: "All projects" first with a divider after it, then the active projects, then
"New project" and "Manage projects". Switching project keeps the list page you're on (Functions, Invocations, Errors);
from a trace or a settings page it opens Functions (`switchProjectLink`, unit-tested).
Menu and ⌘K links carry the current scope (on settings pages: the workspace's last-used project, else All projects;
`useNavScope`).

**Narrow screens** (below Tailwind's `md`, 768 px; `useIsDesktop` in `lib/utils/media.ts` picks the header and the
table mode, so only one ⌘K listener is mounted). The header is a compact bar (`mobile-nav.tsx`): logo, the current
project's name as a switcher trigger (truncated), search and a menu button. Both open a right-hand sheet
(`components/ui/sheet.tsx`, Radix Dialog: focus trap, Esc and overlay close) that closes on every navigation
(`location.key`). The menu sheet lists the pages (active one marked), workspaces (when there are several) and projects
(All projects first), the time range presets and the account (email, sign out); the trigger's sheet shows only the
workspace and project lists. Below `md`:

- `DataTable` renders `renderCard` rows instead of the table when a page passes one: Invocations (function, duration,
  result, time, trigger and project; tapping opens the trace) and Errors (error, pattern, count, last seen, function;
  tapping expands the first-seen date, the variants and the Sample trace / Invocations buttons). Other tables scroll
  horizontally inside their bordered box (`Table`'s wrapper), never the page.
- Buttons, inputs, selects, tabs and the Live pill are at least 40 px tall (`max-md:` variants on the shared
  components), and filter bars wrap with the search on its own row.
- Settings' section nav is a horizontally scrolling row that keeps the current section in view.
- The trace page stacks graph, then tabs. The waterfall's name column is 40% instead of 48% below `sm`, with smaller
  indents, a narrower duration column and only the 0 / middle / end time labels.
- Between `md` and `lg` the full header hides the time range's label (icon only) so the names fit.

Checked at 375 px, 768 px and desktop on every main route: no horizontal page scroll. The MCP App views reuse the
waterfall and tabs, so in an iframe narrower than 640 px they get the same narrow waterfall.

Creating a workspace or project takes a name only: the server makes the slug (with `-2`, `-3`, … on collisions), and
renaming never changes it. Settings show the URL read-only, with "Change URL" under Advanced.

**Settings.** General (name, URL, delete with the slug typed to confirm; owners only, not for the default workspace or
in single-workspace mode), Members (multi-workspace mode only: roles, remove/leave, invitations with the link shown
once to copy, "email sent" when SMTP is configured, pending list with revoke), Projects (create, rename, change URL,
archive/unarchive, archived projects in a collapsed "Archived (N)" section at the bottom; archiving any project, the last active one too, asks once: keys created for it stop working, its
data stays until retention, it can be unarchived; per-project ingest keys: create (shown once, with the
environment variables), list, revoke), AWS
accounts (below). The AWS entry shows the number of new untraced functions.

**Onboarding.** The first time a workspace with no data in the last 7 days and no AWS accounts is opened, the Functions
page sends the user to the quick-start wizard. Once it was finished or skipped (`ivy.welcomeSeen.<ws>` in localStorage)
the page shows a two-step empty state instead (create the first project, then connect AWS or copy an ingest key).
A workspace without active projects (new, or all archived) always shows that empty state on Functions.

**Quick-start wizard** (`/welcome/<step>`; progress in the URL; "Skip" goes to All projects' Functions; "Go to
Functions" after the first trace goes to the project that received it, since that is the one the wizard set up):

1. `workspace`: the name, prefilled from a work email's domain (`erin@acme.io` → "Acme") or the user's name. Only
   for owners in multi-workspace mode, and skipped after joining through an invitation.
2. `project`: creates the first project (workspaces start without one). Hint: environments are separate projects.
3. `aws`: the connect form (the new project is remembered as the last used one, so the function picker preselects it) → the quick-create link, or the template download with upload
   steps when there's none → "I've deployed it" (verify, polled every 10 s) → the stack-grouped function picker to trace
   stacks or patterns into the project. Or "set it up by hand": an ingest key with `AWS_LAMBDA_EXEC_WRAPPER`,
   `IVY_ENDPOINT`, `IVY_API_KEY`, and a note for other OTLP senders.
4. `listen`: polls the project's invocations (`since=1h&limit=1`) every 3 s, with tips meanwhile; then links to the
   trace and to Functions.

## Routes

Paths below are relative to `/w/:workspace/:project`.

- `/functions`: totals charts (invocations, errors, p95) from `stats/timeseries`, plus a table from `functions` with
  per-function sparklines, error rate, cold starts, p50/p95 and the auto-trace state in a "Tracing" column (matched by
  region + name; functions not in a connected account show "Manual"). Under `all` the totals charts sum every project
  (`/api/w/:ws/stats/timeseries`) and each row's sparklines are its own project's.
- `/invocations?function=&status=&q=&live=`: filters (and the Live toggle, below) live in the URL so links can deep-link into a filtered list.
  The search box takes the API's `q`, so `key=value` span attribute terms work there; its placeholder mentions
  `key=value` and its tooltip explains it.
  It suggests attribute keys (`components/invocations/invocation-search.tsx`, logic in
  `lib/search/attribute-suggestions.ts`): the keys from `…/invocations/attributes`, fetched on first focus, filtered
  by the word at the caret (keys starting with it, then keys containing it; the eight most used when it is empty).
  Nothing is suggested once the word has its `=`. Picking one (click, or arrow keys then Enter/Tab) replaces the word
  with `key=`; Enter without a highlighted suggestion searches as before, so free-text search is unchanged.
  Uses cursor pagination (a stack of `next_cursor`s for Previous/Next). With `function` set, the function's
  charts are shown, as on trace-stack's per-function page. Under `all` the list and charts cover every project that
  has the function, and rows link to their project's trace.
- `/traces/:traceId?invocation=<span_id>`: the trace-stack layout. The header has status, duration, cold start,
  billed duration, init duration, memory used against the limit (red when the limit was reached) and AWS console
  links. Failures outside the handler get a `FailureBadge` ("Init failed", "Out of memory", "Timed out", "Crashed")
  here, in the invocation list and on the errors page; when the extension had to create the invocation span itself
  (init failure, crash), a note under the header says there is no (complete) trace and that the Logs tab holds the
  log tail. The MCP App views' header uses the same components (`InvocationStatus`, `BilledDuration`, `MemoryUsage`, `FailureNote`).
  `BilledDuration` shows a cost estimate on hover (`invocationCost` in `@ivy/spans`): memory limit in GB × billed
  seconds × the GB-second rate for `host.arch` (x86_64 assumed when a trace predates that attribute), plus the
  per-request fee. The rates are us-east-1 list prices hard-coded in `cost.ts`; update them there if AWS changes them. The service graph is on the left, with tabs on the right: Overview (error +
  stack, invocation fields, the app's own attributes, event payload, return value), Timeline (waterfall, where expanding a row shows its
  service-specific details and payloads) and Logs (`log` events; JSON logger lines as message plus fields, see
  `span-conventions.md`, "Logs"). When a trace contains several invocations,
  an "Only this invocation" switch scopes the view (this replaces trace-stack's "Filter current invocation").
  The app's own attributes (`customAttributes` in `@ivy/spans`: everything outside the layer's reserved namespaces,
  `span-conventions.md`) are an "Attributes" list under the invocation fields, and also in the invocation row's
  details in the timeline, which is where the MCP App views (no Overview tab) show them.
  Clicking a graph node opens and scrolls to its spans in the timeline. The route is lazy-loaded so React Flow
  stays out of the main bundle.
- `/errors?function=`: groups from `errors` (`error-grouping.md`): the message template with its placeholders muted
  (`ErrorTemplate`), variants, occurrences, first and last seen. A group with several distinct messages expands (chevron
  or "N variants") to its most frequent messages with counts, each linking to its trace. Buttons: the sample trace, and
  `invocations?function=…&group=<fingerprint>` (the list shows a removable "One error group" filter).
- `/query?q=<saved query ID>`: SQL over the views `invocations`, `spans` and `logs` of the current project (or all
  projects) and time range, with saved queries and a schema panel on the left, a CodeMirror editor with completion,
  and the results as a table (trace IDs link to the trace; CSV download). Lazy-loaded. See `query.md`.
- `/w/:workspace/settings/aws`: AWS accounts (see `auto-trace.md`). A "Connect AWS account" dialog (account ID, stack
  region, regions → quick-create link opened in a new tab, or template download + upload
  instructions when there is no link → verify, polled every 10 s), one card per account (status, regions, last sync,
  function counts by state, "N new", sync errors, Sync / Regions / Disconnect; pending accounts get "Finish setup"),
  and the workspace's tracing rules in evaluation order (enable, delete, move up/down).
- `/w/:workspace/settings/aws/:id`: the opt-in function picker. Functions are grouped by CloudFormation stack and
  region ("Other functions" last). Each group shows its counts and either its stack rule (project, on/off, delete) or a
  "Trace stack" button: a dialog with the project prefilled from the stack name (a new project with that slug, or an
  existing one) and a dry-run preview, which saves a stack rule. A filter bar (name glob, stack glob, `tag key=value`,
  region) shows a live "N functions match" from `rules/dry-run` and offers "Trace all matching" (saves the filter as a
  rule). Checkboxes with "Trace selected" / "Exclude selected" set manual choices in bulk; each function has a menu to
  trace it into a project, exclude it, or follow tags and rules again. Rows show the state, the project and what decided
  it (tag, manual, rule). The page notes that moving a function only affects new data. A few seconds after opening, the
  account is marked reviewed (clears "N new").
- `/w/:workspace/settings/usage`: plan, this month's traces of all the workspace's projects against the quota, the
  80%/100% notice (also shown app-wide on the workspace's pages), and, for owners only, Upgrade / Manage billing when
  `/api/config` has a billing URL; members see "Only workspace owners can change billing". `/settings/usage` redirects
  there. See `limits.md`.
- Global: a time range picker (presets map to `since`, custom ranges to `from`/`to`; the preset is stored in
  localStorage), a ⌘K search (functions, jump to a trace ID, search invocations; within the current project), and the
  "Authentication disabled" banner shown when `GET /api/config` returns `auth.enabled: false`.
- Auth (`auth.md`): with OIDC on, every route above needs a signed-in user (`RequireAuth` → `/login?returnTo=…`).
  `/login`, `/auth/callback` and `/logout` render outside the layout. The header has a user menu (email, sign out);
  notification settings are per workspace under Settings → Notifications (`alerts.md`), not in the user menu.
  `src/lib/auth/` holds the oidc-client-ts wrapper, the provider, `returnTo` handling and the `ivy_session` marker cookie.

## In-progress invocations

The extension exports a provisional invocation span (`ivy.in_progress`) for invocations that run past a threshold
(`layer.md`, `span-conventions.md`). The list API returns them with `status: "in_progress"`, `deadline` and
`last_seen`; on the trace page the root carries `ivy.in_progress`, `ivy.deadline_ms` and `ivy.last_seen_ms`.
Components in `src/components/common/in-progress.tsx`, used by the invocation list, the trace page and the MCP App
views (header and waterfall), so the three stay in sync:

- `InProgressStatus`: "Running…" with a pulsing dot (static under `prefers-reduced-motion`), then "No completion
  recorded" in amber, with `NO_COMPLETION_EXPLANATION` in a tooltip, once `inProgressState` (`@ivy/spans`) says the
  deadline plus a 15 s grace has passed. Clients decide this from `deadline` and the clock, so a row flips without a
  reload.
- `Elapsed`: time since the start, ticking every second (`useNow`); after the deadline, `> <last reported>`.
- `InProgressNote`: a note under the trace header (sky while running, amber afterwards).
- Waterfall: the root bar of a running invocation is sky with slowly moving stripes and a faded open end (`.running-bar`
  in `index.css`; no animation under reduced motion); without completion it is amber, faded, without stripes.
- The status filter has "Running" (`status=in_progress`).

## Live mode (Invocations page)

A "Live" pill next to the filters (`?live=1`, project and All projects) with a pulsing green dot while it updates.
Logic in `src/lib/live/` (`live.ts` pure functions with tests, `use-live.ts` the hook):

- Every 3 s (`LIVE_INTERVAL_MS`, never under 2 s) it asks the existing list endpoint for rows newer than the newest
  shown: `from=<newest ts − 1 s>`, the current filters and search, `limit=100`. Rows are merged by trace + span ID:
  known rows are replaced in place, new ones prepended with a short green fade (`.live-fresh`). The list holds at
  most 200 rows. If a poll returns a `next_cursor` (more than 100 new rows) the first page is reloaded instead.
- In-progress rows on screen are refreshed in place with one extra request, `ids=<span IDs>` (at most 100) over the
  page's range, so "Running…" turns into the final result.
- Live needs a relative range so that it follows now; switching it on with a custom range selects "Last hour".
- Pauses: a hidden tab (Page Visibility API) and 15 minutes without input stop polling, the latter with "Live paused"
  and a Resume button. Scrolling down (more than 240 px) or opening another page keeps polling but holds new rows back
  ("Paused, N new · Resume"); Resume merges them (or reloads the first page after paging) and scrolls to the top.
- Cost: one list query per 3 s per open tab while live and visible (two when in-progress rows are shown). Failed
  polls back off (6, 12, 24, then 30 s) and nothing is polled when the toggle is off.
- Mock mode: the first live poll (`from` without `to`) starts a stream of new invocations every 4 s, every third
  running for 9 s first; the seeded running import completes 20 s later, and a queue run shows "No completion
  recorded" (`src/lib/mock/progress.ts`). The MCP host has "in progress" and "no completion" fixtures.
- The website's trace demo (private repo) is a copy: it needs the in-progress states if it shows invocation lists or
  traces.

## Span → service rendering (`src/lib/spans/services.ts`)

`describeSpan(span)` returns the icon, service label, operation, target, a short note, key/value fields,
parsed payloads, a grouping key (used for graph nodes) and a graph label. Everything about AWS services
lives here.

| Span | Detected by | Title: operation · target – note | Fields |
|---|---|---|---|
| Invocation | `ivy.invocation = "true"` | Function `name` – `METHOD route – status` or "triggered by X" (`ivy.trigger.source`) | request ID, trigger, cold start, memory, region, ARN |
| DynamoDB | `rpc.system=aws-api`, `rpc.service=DynamoDB` | `rpc.method` · `aws.dynamodb.table_names` (fallback `TableName` in request) – "N items returned" from response `Count`/`Items`/`Responses`, or "item not found" for GetItem | table, index, key, key condition, filter, scanned |
| S3 | `rpc.service=S3` | method · `s3://aws.s3.bucket/aws.s3.key` – size (`ContentLength`) or "N objects listed" | bucket, key, prefix, content type, size, ETag |
| SQS | `rpc.service=SQS` | method · `messaging.destination.name` (fallback: last segment of `QueueUrl`) – message ID / "N messages" / "N messages received" | queue, queue URL, message ID, group, delay |
| SNS | `rpc.service=SNS` | method · `messaging.destination.name` (fallback: `TopicArn`) – subject or message ID | topic, ARN, phone, subject, message ID |
| Lambda | `rpc.service=Lambda` | method · `faas.invoked_name` – "async" / status / function error | function, `faas.invoked_region`, invocation type |
| EventBridge | `rpc.service=EventBridge` | method · `aws.eventbridge.bus` – `aws.eventbridge.detail_types` (+ failed count) | bus, detail types, entries, sources |
| SES / SESv2 | `rpc.service=SES`/`SESv2` | method · recipients – subject (v1 and v2 request shapes) | from, to, subject, message ID |
| Secrets Manager | `rpc.service=SecretsManager` | method · `SecretId` | secret |
| Other AWS | `rpc.system=aws-api` | `rpc.service` icon "aws" · method | |
| HTTP | CLIENT span with `http.request.method` or `url.full` | method · `url.full` – status | URL, host (`server.address`), port, status. Request/response headers come from `ivy.http.*.headers`. Known hosts (Slack, Shopify, Chargebee, Todoist, CloudFront, legacy S3/SES/EventBridge hostnames) get their own icon |

**Collapsed calls and omitted spans** (`collapsed.ts` in `@ivy/spans`; attributes in `span-conventions.md`). A
summary span (`ivy.collapsed.count`, named e.g. `DynamoDB.PutItem × 1,184`) is described like the calls it stands for:
the ` × N` suffix is stripped from the name and `describeSpan` returns `collapsed` (count, total, average, max, min,
errors, kept, signature). HTTP summaries have no `url.full`, so the target is `server.address` + `http.route`.

- Waterfall row: the base title plus a `× 1,184` outline badge (`CollapsedBadge`, tooltip "N similar calls
  summarised in one span"). The bar runs from the first call's start to the last call's end and is hatched at 70%
  opacity so it doesn't read as one long call; the duration column is that first → last span.
- Details: a line explaining that the calls were summarised (first, slowest and failing calls are kept as their own
  spans), then Calls, Total, Average, Max, Min, Errors (kept in full), Kept in full, Signature, and "First → last"
  instead of Duration.
- Service graph: a summary span counts as its number of calls (shown as `1.2k` from 1,000 on).
- When the invocation has `ivy.dropped_spans`, an amber note above the waterfall (`OmittedSpansNote`, styled like
  `FailureNote`) says e.g. "37 spans omitted (span limit): this invocation made more calls than Ivy keeps, so the
  timeline is incomplete", plus the `ivy.collapsed_calls` total. The MCP App waterfall view shows the same components.
- Mock: `checkout-importOrders` in `checkout-prod` (S3 trigger, every 3 hours, ~10 s) uses `@ivy/format`'s import
  fixture (`import-spans.ts`); the latest run is `/w/acme/checkout-prod/traces/ca11ab1e00000000000000000000a1b2`.

All AWS spans also show `cloud.region`, `http.response.status_code` and `aws.request_id`.
`ivy.payload.request/response` are parsed as JSON after stripping the `…[truncated N bytes]` marker. If
parsing fails (for example on truncated JSON), the raw string is shown. `ivy.payload.truncated` adds a
"(truncated)" label. Array attributes accept JSON arrays or comma-separated strings. Exceptions come from the
`exception` event, falling back to `error.type` + `status_message`.

## Changes from trace-stack

- Data model: Lumigo-style transactions (`info.httpInfo`, `dynamodbMethod`, host-regex service detection)
  replaced by OTel spans and semantic attributes. Host regexes remain only as a fallback for HTTP spans.
- Code: no `any`. One fetch client plus one SWR hook per endpoint replaces ad-hoc `useData` path strings
  and token handling. Mapping logic is pure and unit-tested instead of spread across components. The large
  components (`transaction-details`, `invocation-details/page`) are split into `components/trace/*`. Removed:
  auth/login/users pages, toasts, unused shadcn components, localStorage-backed table state, and the old
  column filter popovers (replaced with Selects bound to URL params).
- Visuals: same header, page density, service icons, graph-left/tabs-right trace layout and JSON viewer.
  Changes:
  - The flat transaction list is replaced by a waterfall with time ticks, per-service bar colours and
    expandable rows.
  - Payloads are collapsible sections with copy and expand-all buttons.
  - Pages have consistent loading, error (with retry) and empty states.
  - The custom date range uses `datetime-local` inputs instead of react-day-picker.
  - New icons for SQS, SNS, Secrets Manager and generic AWS.
- Dark-only by design: one dark palette in `:root`, `color-scheme: dark`, and a dark background in
  `index.html` so there's no white flash on load. There is no theme toggle and there are no `dark:`
  variants. Status colours use the 400 shades (emerald, amber, red) for contrast on the dark background.
