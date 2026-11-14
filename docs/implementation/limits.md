# Limits and usage

Spec M6: monthly quotas enforced at ingest. Ivy counts **traces**: one trace is one Lambda invocation, i.e. one row of
`invocations` (a root span with `ivy.invocation = true`). Usage is per workspace (tenant) and per calendar month in
UTC.

Public Ivy only has the generic part: a limits table, a usage count, enforcement in the ingest router, an internal
admin API, and a usage page that can show billing buttons. Plans, prices and payments live with whoever operates
the install (for ivytrace.dev: the private `ivy-hosted` repo's billing service). **Self-hosted installs are unlimited
and have no payment code**: without a limits row a workspace is unlimited, and nothing creates rows by default.

## Model

`ivy_control.workspace_limits` (ReplacingMergeTree on `updated_at`, `deleted` flag, like the other control tables):

| column | |
|---|---|
| `tenant_id` | the workspace |
| `plan` | a label shown in the UI (`Free`, `Pro`, …); Ivy attaches no meaning to it |
| `monthly_trace_quota` | `Nullable(UInt64)`; NULL is unlimited |
| `over_quota` | `block` (ingest answers 429 at the quota) or `allow` (keeps accepting; the operator bills the overage) |
| `updated_at`, `deleted` | |

No row means unlimited (`source: "unset"` in API answers). There are no install-wide defaults: an operator that wants
a free tier for new workspaces sets a row when the workspace is created (hosted does this with a workspace hook plus a
reconcile sweep, see ivy-hosted's `billing.md`).

Code: `packages/api/src/lib/limits/` (`limits.ts` types and validation, `store.ts` the table, `usage.ts` the count,
`quota-gate.ts` the router check, `present.ts` the response shape).

## Usage count

`countMonthlyTraces(tenant, month)` counts `invocations` from the first millisecond of the month to now: whole hours
from `invocations_hourly`, the partial hours at the edges from raw `invocations`, the same split the data routes use
(`storage.md`), so the number is exact, not an estimate. One small query per tenant (a few hundred rollup rows plus
at most two partial hours of raw rows).

- The dashboard's `GET /api/usage` caches it per tenant for 60 s.
- The internal API counts fresh on every call (billing reports it).
- `countMonthlyTracesAllTenants(month)` runs one `GROUP BY tenant_id` per shard for the internal list.

Spans that arrive late (a batch held back by the layer, the collector's queue) are counted in the month of their
timestamp, so a month's count can still grow by a few traces after it ends.

## Enforcement in the ingest router

`QuotaGate` (`lib/limits/quota-gate.ts`), wired in `ingest.ts`. Per request, after the key lookup and before the body
is read:

1. Per tenant it holds a **snapshot**: the limits row, and the month's count from ClickHouse (only queried when the
   limits can block: a quota and `block`).
2. Plus a **local counter**: invocations in requests this router process forwarded successfully since the snapshot's
   query started. The router already walks every body to count spans; it now also counts spans whose attributes have
   `ivy.invocation` = `true` (bool or string, protobuf or JSON).
3. Blocked when `over_quota = block`, the quota isn't null, and `snapshot + local ≥ quota`.
4. The snapshot is refreshed every `IVY_QUOTA_REFRESH_SECONDS` (60) in the background: the request that finds it stale
   is answered from the old snapshot, the next ones from the new. The first request of a tenant (or of a new month)
   waits for its first snapshot; concurrent ones share the query.
5. If the lookup fails, ingest is **allowed** (fail open: a ClickHouse hiccup must not drop customers' traces) and
   retried after 10 s.

Answer when blocked (OTLP/HTTP, a `google.rpc.Status` in the request's encoding, like every router error):

```
HTTP/1.1 429 Too Many Requests
Retry-After: 300
{"code":8,"message":"Monthly trace quota reached (100,000 traces on the Free plan). Traces are rejected until the
next month (UTC). Upgrade at https://ivytrace.dev/settings/usage."}
```

`Retry-After` is `IVY_QUOTA_RETRY_AFTER_SECONDS` (300), or the seconds until the month ends if sooner. Not "until the
next month": an upgrade should take effect within minutes, and clients that honour the header (the Ivy layer does)
come back at that interval. The upgrade link is `IVY_UPGRADE_URL`, else `IVY_PUBLIC_URL/settings/usage`, else a
generic sentence.

### Tolerance

The check is cheap (an in-memory comparison per request), not exact to the trace:

- **One router:** overshoot is at most one request's worth of invocations (the request that crosses the quota is
  accepted whole; requests are not split). Spans accepted while a refresh query runs are kept in the local counter, so
  they aren't lost; spans still in the collector's batch (≤ 1 s) when the query runs may be counted twice until the
  next refresh, which only makes the router block slightly early, by at most a second of traffic.
- **N routers:** each only knows its own local count, so the fleet can overshoot by up to (N − 1) × one refresh
  interval of the tenant's traffic before the next refresh.
- **Changes to limits** (an upgrade, a downgrade) take effect within one refresh interval plus one request per router.
- Fail-open on lookup errors means a ClickHouse outage suspends enforcement.

Billing is computed from the stored count (`invocations`), never from the router's counters, so overshoot is at most
free traffic, never a wrong invoice.

### The Lambda layer

A 429 is drop-and-count, without hammering (`layer.md`, Delivery):

- The transport stops retrying at once on a 429 or 503 that carries `Retry-After` (it used to retry twice within the
  flush) and hands the delay to the queue.
- The queue drops the batch, counts it in `ivy.dropped_spans`, and sends nothing until the delay has passed (capped
  at 1 hour), not even the forced flush at `SHUTDOWN`. Spans in that window are buffered up to `IVY_MAX_QUEUE_SPANS`
  and the oldest are dropped and counted.
- So an execution environment over quota sends at most one request per `Retry-After` (5 minutes), not one per
  invocation.

## Internal admin API

For an operator's billing service. Documented in `api.md`, "Internal admin API". Mounted at `/internal/*`, outside
`/api`, so a proxy that only routes `/api/*` (CloudFront on ivytrace.dev) never exposes it. It exists only when
`IVY_INTERNAL_API_TOKEN` is set (at least 32 characters; otherwise every `/internal/*` path is 404) and every call needs
`Authorization: Bearer <that token>` (401 otherwise, compared in constant time). OIDC and the tenant middleware don't
run there.

### Decision: membership through the internal API, not the user's token

Billing needs to know whether the person clicking "Upgrade" owns the workspace. It verifies their Ivy access token
itself (same issuer and audience), then asks `GET /internal/workspaces/:id/members`. The alternative, calling Ivy's
public API with the user's token, would tie billing to the public API's shape (which is moving to `/api/w/:workspace`)
and to the token being accepted for that call; the internal call is one stable endpoint with the role in it.

## UI

`Settings → Usage` (`/settings/usage`, `routes/settings/usage/page.tsx`): plan label, traces this month, a progress
bar against the quota (or "Unlimited"), and an explanation. A banner shows at 80% and at 100% of a quota that blocks,
on every page (`components/layout/usage-banner.tsx`) and on the usage page. With `over_quota = allow` (paid) there is
no banner; the bar shows the included traces.

When `GET /api/config` has `billing.url` (`IVY_BILLING_URL`), the page shows **Upgrade** (no paid plan) or **Manage
billing** (a workspace row with `allow`). The button `POST`s `{ "workspace": "<id>" }` to `${url}/checkout` or
`${url}/portal` with the user's bearer token and redirects to the `url` in the answer. Errors (e.g. 403 for a
non-owner) show under the button. Returning from Checkout with `?checkout=success` shows a notice and re-reads usage a
few times while the webhook lands. Without a billing URL there are no billing buttons.

Mock mode: `VITE_MOCK_USAGE=free|near|over|paid|unlimited` (default `free`, 62%), `VITE_MOCK_NO_BILLING=1` hides the
buttons; the mock billing service answers at `/api/mock-billing/*` and "checks out" straight back to the success page.

Only the dashboard has this page: the MCP views and the website demo show traces, not settings.

## Configuration

| variable | used by | default | |
|---|---|---|---|
| `IVY_INTERNAL_API_TOKEN` | API | | enables `/internal/*`; ≥ 32 characters |
| `IVY_BILLING_URL` | API (→ UI) | | billing service base URL, e.g. `https://ivytrace.dev/billing` |
| `IVY_QUOTA_REFRESH_SECONDS` | router | `60` | snapshot refresh |
| `IVY_QUOTA_RETRY_AFTER_SECONDS` | router | `300` | `Retry-After` while over quota |
| `IVY_UPGRADE_URL` | router | `$IVY_PUBLIC_URL/settings/usage` | link in the 429 message |

## Verification

- Unit: `limits/limits.test.ts` (validation, unset = unlimited, block/allow, months), `limits/usage.test.ts` (rollup
  plus edges, tenant binding, caching, the all-tenants query), `limits/quota-gate.test.ts` (unlimited, allow, block,
  local counting, background refresh, upgrades, month rollover and the Retry-After cap, shared first load,
  fail-open), `ingest/router.test.ts` (429 + Retry-After + message with nothing forwarded, counting accepted
  invocations, allow, unlimited by default), `ingest/otlp.test.ts` (invocation counting), `routes/internal/internal.test.ts`
  (disabled without a token, short tokens, 401, CRUD, validation, the list and `limits=unset`, members, `/api/usage`,
  `/api/config` billing), `tenant-scope.test.ts` (`/api/usage` is tenant-bound), layer `export/transport.test.ts` and
  `export/queue.test.ts` (Retry-After), UI `lib/usage/state.test.ts` (free under / near / over quota, paid, unlimited,
  mock billing).
- Compose stack on alternate ports (API :33100, ingest :34418, ClickHouse :38223, `IVY_QUOTA_REFRESH_SECONDS=5`): a
  new tenant with no row ingested freely; with `quota 15, block` and 10 stored, requests of 3 and 2 invocations were
  accepted and the next got 429 with `Retry-After: 300` and the message; the `default` tenant kept ingesting; after
  switching to `allow`, the first request still got 429 (stale snapshot, refresh started) and the next ones 200;
  ClickHouse held exactly 17 invocations for the tenant (10 + 5 + 2). `/internal/*` answered 401 without or with a wrong
  token, `/api/internal/*` 404, `limits=unset` listed only `default`, `/api/config` carried `billing.url`.
- Dashboard in mock mode: the four states and the Upgrade round trip, checked in the browser.

## Gaps

- No per-query limits yet (the other half of M6).
- Router counters are per process; see Tolerance.
- The workspace's role isn't known to the UI on this branch (no workspace routes yet), so non-owners see "Upgrade"
  and get billing's 403 message.
