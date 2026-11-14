# UI (`packages/ui`)

React dashboard, started from `includable/trace-stack`'s `packages/dashboard`. Trace-stack served as a
visual reference. Most of the code was rewritten.

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

The mock (`src/lib/mock/`) is a Vite middleware plugin, enabled only when `VITE_MOCK=1`. The `/api/aws/*` part
(`aws.ts`) keeps state while the dev server runs: two connected accounts with functions in every state, and new
connections verify 8 s after they're created. `VITE_MOCK_EMPTY=1` starts with no accounts and no trace data (the
"connect an account" empty state); `VITE_MOCK_NO_TEMPLATE=1` shows the template download fallback. It serves every
endpoint in `api.md` from deterministic generated data: a week of invocations across four functions,
filters, `since`/`from`/`to`, cursor pagination, error groups, timeseries buckets, and full traces with
DynamoDB, S3, SQS, SNS, EventBridge, SES, Lambda, Secrets Manager and fetch spans, logs and exceptions.
`server.test.ts` checks it against the contract.

## Layout

```
src/lib/api/       client.ts (fetch + URL building), hooks.ts (SWR hooks per endpoint), types.ts (api.md types)
src/lib/spans/     services.ts (span → service rendering), tree.ts (waterfall), graph.ts (service graph)
src/lib/mock/      fixtures + mock server for dev:mock
src/lib/links/     route builders
src/lib/utils/     cn, formatting
src/components/    layout/, common/ (states, status, service icon), stats/ (charts, payloads), trace/, tables/, ui/ (shadcn)
src/routes/        functions/, invocations/, traces/, errors/
```

## Routes

- `/functions`: totals charts (invocations, errors, p95) from `/api/stats/timeseries`, plus a table from
  `/api/functions` with per-function sparklines, error rate, cold starts and p50/p95.
- `/invocations?function=&status=&q=`: filters live in the URL so links can deep-link into a filtered list.
  Uses cursor pagination (a stack of `next_cursor`s for Previous/Next). With `function` set, the function's
  charts are shown, as on trace-stack's per-function page.
- `/traces/:traceId?invocation=<span_id>`: the trace-stack layout. The header has status, duration, cold start,
  memory and AWS console links. The service graph is on the left, with tabs on the right: Overview (error +
  stack, invocation fields, event payload, return value), Timeline (waterfall, where expanding a row shows its
  service-specific details and payloads) and Logs (`log` events). When a trace contains several invocations,
  an "Only this invocation" switch scopes the view (this replaces trace-stack's "Filter current invocation").
  Clicking a graph node opens and scrolls to its spans in the timeline. The route is lazy-loaded so React Flow
  stays out of the main bundle.
- `/errors?function=`: groups from `/api/errors`, linking to the sample trace and to
  `/invocations?function=…&status=error&q=<message>`.
- `/settings/aws`: AWS accounts (see `auto-trace.md`). A "Connect AWS account" dialog (account ID, stack region,
  regions → quick-create link opened in a new tab, or template download + upload instructions when the server has no
  template URL → verify, polled every 10 s), and one card per account with status, regions, last sync, function
  counts by state, sync errors, and Sync / Regions / Disconnect actions. Pending accounts get "Finish setup".
- `/settings/aws/:id`: the account's functions with state, reason and a tracing toggle, filterable by state.
  The Functions page has the same toggle and state in a "Tracing" column (matched by region + name; functions not in a
  connected account show "Manual"), and its empty state links to the connect dialog when no account is connected.
- Global: a time range picker (presets map to `since`, custom ranges to `from`/`to`; the preset is stored in
  localStorage), a ⌘K search (functions, jump to a trace ID, search invocations), and the "Authentication
  disabled" banner shown when `GET /api/config` returns `auth.enabled: false`.
- Auth (`auth.md`): with OIDC on, every route above needs a signed-in user (`RequireAuth` → `/login?returnTo=…`).
  `/login`, `/auth/callback` and `/logout` render outside the layout. The header has a user menu (email, sign out).
  `src/lib/auth/` holds the oidc-client-ts wrapper, the provider, `returnTo` handling and the `ivy_session` marker cookie.

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
