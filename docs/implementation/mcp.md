# AI-native surface: MCP, MCP Apps, text traces, OpenAPI

How agents use Ivy (milestone M5). All on the API server:

- **Remote MCP server** at `/mcp`: read-only tools that answer in compact text, across all of the caller's
  workspaces, plus two **MCP Apps** tools that show a trace as an interactive view in hosts that support it.
- **`GET /api/traces/:traceId?format=text`**: one trace as an LLM-friendly text tree.
- **HTTP API** described by an OpenAPI 3.1 document at `/api/openapi.json`, browsable at `/api/docs`.

**No CLI.** The spec planned a CLI that mirrors the MCP tools. We dropped it: agents already speak MCP or
HTTP, so a CLI would be a third copy of the same queries to maintain.

## Packages

| package | what |
|---|---|
| `@ivy/spans` | Span types, API response types, the service-aware span describers (`describeSpan`, `getException`, …) and `buildServiceGraph`. Moved out of the UI so the UI, the formatter and the MCP server share them; `packages/ui/src/lib/spans/{services,types,graph}.ts` re-export it. |
| `@ivy/format` | Pure text renderers: `formatTrace`, `formatInvocations`/`formatInvocationLine`, `formatErrorGroups`, `compareTraces`, `formatServiceGraph`. Snapshot tests on fixtures in `src/lib/fixtures/traces.ts` (also exported as `@ivy/format/fixtures`). |
| `@ivy/mcp` | The MCP server (`createIvyMcpServer`), its tools, the workspace fan-out, the MCP Apps tools and resources, bearer auth and the Hono routes (`mcpRoutes`). Knows nothing about ClickHouse: it reads through an `IvyData` interface. |
| `@ivy/ui` `src/mcp-apps/` | The MCP Apps views, built from the dashboard's own components (see MCP Apps). |

The workspace packages export TypeScript source (`exports` points at `src/index.ts`); Vite, tsx, Vitest and
esbuild compile them in place, so there is no build step.

## Text trace format (`@ivy/format`)

```
checkout-createOrder · API Gateway POST /orders → 500 · cold start · 212ms · ERROR
trace 6af84d409a1b… · request 8f1c2d3e-… · eu-west-1 · 2026-11-14T12:00:00.000Z · 96 MB used · 4 spans

   +0.0ms    212ms  checkout-createOrder [invocation] API Gateway POST /orders → 500  ERROR
                      ! TypeError: Cannot read properties of undefined (reading 'id')
                        at createPaymentIntent (/var/task/src/payments.js:42:31)
                      req: {"routeKey":"POST /orders","headers":{"authorization":"[redacted]",…}
   +2.0ms             log info: Creating order for cart cart_u_8812
   +4.0ms   11.6ms    DynamoDB.GetItem checkout-users (1 item returned)  ok
  +36.0ms    135ms    POST api.stripe.com/v1/payment_intents → 402  ok
                        res: {"error":{"code":"card_declined",…}}
```

- Header: function, trigger (with HTTP method, route and status), cold start or warm, duration, status; then
  trace ID, request ID, region, start time, memory, span count. Traces without an Ivy invocation span (plain
  OTel producers) get a header from the root span.
- One line per span: offset from the trace start, duration, two spaces of indentation per level, the
  description from the UI's describers, status (`ok`/`ERROR`). Logs sit between the spans at their time.
- Detail lines under a span: `!` error with type, message and stack frames (Node internals, the Lambda runtime
  and the Ivy layer wrapper are dropped); `req:`/`res:` payloads.
- Payloads are shrunk structurally (strings over 120 chars, arrays over 5 items, nesting over 5 levels), then cut to
  `payloadChars`. Redaction happens in the layer before storage; trimming never touches keys or `[redacted]`
  values. Payloads cut by the layer are marked `[cut at source, N bytes dropped]`.
- Three or more consecutive identical successful leaf calls fold into one line: `DynamoDB.GetItem orders ×8 (each 6.2ms–11.1ms)`.
- Summary spans (runs of similar calls the layer collapsed, `ivy.collapsed.*`, see `span-conventions.md`) get the
  count and their stats; the duration column is first start to last end. The failing calls and the other kept ones
  are their own lines, and summary spans never fold with them:
  `DynamoDB.PutItem orders × 1,184 (first→last 9060ms, total 6130ms, avg 5.2ms, min 2.1ms, max 29.8ms, 1 error, 9 kept)`.
- When the invocation span has `ivy.dropped_spans`, the header gets a third line, e.g.
  `37 spans omitted (span limit) · 1,496 similar calls collapsed into summary spans (× lines)` (from
  `ivy.collapsed_calls`). It is always kept when fitting the token budget. The helpers are `collapsedInfo`,
  `droppedSpans`, `droppedSpansLabel` and `collapsedCalls` in `@ivy/spans`; the service graph counts a summary span as
  its number of calls and its total time.
- `detail`: `summary` (no payloads, only warn/error logs, 2 frames), `normal` (default; payloads of the
  invocation, of failed calls and of 4xx/5xx calls; all logs; 4 frames), `full` (every payload plus HTTP headers,
  10 frames, no folding).
- `maxTokens` (default 2000, about 4 characters per token; 0 = unlimited): to fit, the formatter halves the payload
  budget down to 80 characters, then falls back to `summary`, then drops lines from the end while keeping the
  header, failed spans, their errors and error logs, noting `… N lines omitted`.

`compareTraces(a, b)` aligns the calls of both traces (pre-order, longest common subsequence on a call key: the
description without counts, status codes and ID-like path segments) and prints top-level differences, the error,
then `=` (same), `~` (different status, HTTP status, a duration more than 2× and 20 ms apart, or a different payload
shape), `+`/`-` (only one side). For `~` calls it lists differing payload fields (up to four per payload); for
calls with the same outcome only structural differences (keys present on one side, type or array length changes),
so IDs and timestamps don't drown the signal.


`formatServiceGraph(trace)` renders the dashboard's service graph as an edge list:
`checkout-createOrder → checkout-orders [DynamoDB UpdateItem, 12.9ms] ERROR`, with call counts for folded nodes.

## MCP server

Streamable HTTP, **stateless** (`sessionIdGenerator: undefined`) with JSON responses (`enableJsonResponse`): every
POST builds a fresh `McpServer` and transport. Nothing to keep in memory, and it works behind any load balancer.
GET (server-sent streams) is not supported; none of the tools need server-initiated messages.

### Tools

All read-only (`readOnlyHint`), with zod input schemas (published as JSON Schema). Outputs are text; every result
line starts with its workspace slug in brackets (`[shop-production] …`). Time ranges are `since` values like `15m`,
`1h`, `24h`, `7d`, as in the API. Every tool except `list_workspaces` takes an optional `workspace` (ID or slug).

| tool | input | output |
|---|---|---|
| `list_workspaces` | – | `slug · name · ID` per workspace. |
| `find_failing_invocations` | `workspace?`, `project?`, `function?`, `since` (1h), `limit` (20, max 100) | Count line, then one line per failed invocation (`formatInvocationLine`), newest first across workspaces. Failures outside the handler carry their label (`Init failed`, `Out of memory`, `Timed out`, `Crashed`), `no request` for init failures without one, and a `no trace: …` note when the runtime never started or the process died before the tracer could report. |
| `search_invocations` | `workspace?`, `project?`, `q?`, `function?`, `status?`, `since` (24h), `limit` (20) | Same lines. `q` is the API's free text (request/trace ID exact, error message or path substring). |
| `list_error_groups` | `workspace?`, `project?`, `function?`, `since` (24h), `limit` (20) | Totals line, then `count× function · [label ·] type: message · first … · last … · sample trace …`, most frequent first; init failure groups say they have no trace spans, and Lambda throttles appear as one `Throttled` line per function (no trace). |
| `get_trace_summary` | `workspace?`, `project?`, `trace_id` or `request_id`, `detail` (normal), `max_tokens` (2000) | `[workspace]` line, then `formatTrace`. A request ID is looked up over the last 7 days. |
| `compare_invocations` | `workspace?`, `project?`, `trace_id`, `baseline_trace_id?`, `max_tokens` | `compareTraces`. Without a baseline: the latest successful invocation of the same function in the same workspace (last 7 days). |
| `render_waterfall` | `workspace?`, `project?`, `trace_id` | MCP Apps view of the span waterfall; text: the `formatTrace` tree. |
| `render_graph` | `workspace?`, `project?`, `trace_id` | MCP Apps view of the service graph; text: the `formatServiceGraph` edge list. |

Errors (unknown trace or workspace, invalid range) come back as tool results with `isError: true` and a sentence
saying what to do next, not as protocol errors, so the model can recover.

**Projects** (`workspaces-projects.md`): every tool that reads data also takes an optional `project` (slug or ID),
next to `workspace`. It narrows each read to that project of the selected workspaces (`scoped()` in
`workspaces/scope.ts` passes it to `IvyData`); workspaces without such a project contribute nothing. Without it,
reads cover every project of each workspace. In the API, `lib/mcp/data.ts` runs the reads through the same query
functions as the HTTP routes (`lib/data/*`, with a `DataScope` per workspace and project), so the project guard
applies too. Result lines are still labelled `[workspace]`.

### Workspaces and the fan-out

A workspace is a tenant. `IvyData.workspaces()` returns the caller's: `default` with auth off or in single-tenant
mode (`IVY_SINGLE_TENANT`), otherwise every tenant in `tenant_members` for the user's `sub` (their own tenant is
created on first use, as for `/api`). Slugs come from the tenant names, made unique among the caller's workspaces.

Every read in `IvyData` is for **one** workspace: the API runs its own route handlers (`getInvocations`, `getTrace`,
`getErrors`) in-process on a small internal Hono app with that workspace's tenant on the context, so each read goes
through `dataQuery` → that tenant's shard client, with the same SQL, validation and tenant guard as `/api`. There is
never one cross-tenant query and no `crossTenantQuery` in this path (`lib/mcp/data.ts`).

The tools fan out in `@ivy/mcp` (`workspaces/fan-out.ts`):

- `fanOut` runs the per-workspace read with at most 4 workspaces at a time and a 10 s timeout per workspace.
- Failures are collected per workspace, not thrown. The answer lists what was read and ends with
  `Not included (query failed): <slug> (<reason>)`; only when every workspace fails is it a tool error.
- Lists are merged and cut to the combined `limit`: invocations newest first, error groups by count, then last seen.
  Each workspace is asked for `limit` rows, so the merged top `limit` is exact.
- Traces (`get_trace_summary`, `compare_invocations`, `render_*`) are located with `locateTrace`: with several
  workspaces it asks each workspace's `invocations` table for the trace ID within an hour of the timestamp in the
  ID's first 8 hex chars (cheap: that table is ordered by tenant and time), then loads the trace only from the
  workspace that has it. Traces without an invocation row or a timestamped ID fall back to loading the trace from
  each workspace until one has it. An explicit `workspace` skips all of that.

`mcp.test.ts` checks that every tool binds the request tenant in every query, and that a two-workspace fan-out
runs one tenant-scoped query per workspace and labels the lines.

### Auth (MCP authorization spec)

The MCP endpoint is an OAuth 2.1 protected resource:

- `GET /.well-known/oauth-protected-resource` and the path-suffixed `/.well-known/oauth-protected-resource/mcp`
  (RFC 9728) return `{ resource, authorization_servers: [IVY_OIDC_ISSUER], bearer_methods_supported: ["header"],
  resource_name, resource_documentation }`. Without OIDC they answer 404.
- `resource` is the canonical MCP URL: `IVY_MCP_RESOURCE` (e.g. `https://ivytrace.dev/mcp`, no trailing slash),
  else `IVY_PUBLIC_URL` + `/mcp`. With OIDC configured and neither set, startup fails.
- No or invalid token: 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`
  (plus `error="invalid_token"` when a token was sent). Clients discover the authorization server from there.
  Provider unreachable: 503.
- Tokens are checked with the OIDC verifier (`lib/auth/verify.ts`, `verifyAccessToken`) with
  `audience: IVY_MCP_RESOURCE` and `mcpClients: true`. MCP clients register at the provider under Ivy's client:
  their `client_id` is an `mcp_…` ID (dynamic registration) or an HTTPS URL (Client ID Metadata Document, e.g.
  Claude's), with `parent_client_id` = `IVY_OIDC_CLIENT_ID` and a `client_name`. With `mcpClients`, a token whose
  `parent_client_id` is our client is accepted whatever its `client_id`; the caller is recorded with
  `agent: { clientId, name: client_name }`. `/api` does not pass `mcpClients` and keeps accepting only the
  dashboard's client and its `agt_` agents; MCP tokens are also rejected there by audience. No token passthrough
  in either direction.
- The verified user goes on the context as `authUser` (same key as `/api`), where workspace resolution reads it.
- Without `IVY_OIDC_ISSUER` the endpoint is open, like the API on self-hosted setups.

`@ivy/mcp` checks tokens through a small interface, `TokenVerifier.verify(token, { audience }) → user | null`; the
API adapts `verifyAccessToken` to it (`lib/mcp/auth.ts`).

#### What the authorization server must support for MCP clients

Includable Auth supports all of this (includable/auth#5):

- OAuth 2.0 Authorization Server Metadata (RFC 8414) or OIDC discovery at the issuer.
- Authorization code flow with PKCE (S256) for public clients.
- Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents, since MCP clients register themselves.
- Resource indicators (RFC 8707): tokens for the `resource` parameter `https://ivytrace.dev/mcp` carry that `aud`,
  distinct from the API audience, plus `parent_client_id` and `client_name`.
- Redirect URIs on `http://localhost:<port>` / `http://127.0.0.1` for local clients, HTTPS callbacks for hosted ones.
- Refresh tokens, so agents keep working past the access token lifetime.

## MCP Apps

`render_waterfall` and `render_graph` are MCP Apps tools (`@modelcontextprotocol/ext-apps`, spec 2026-01-26): their
`_meta.ui.resourceUri` points at `ui://ivy/waterfall.html` / `ui://ivy/graph.html`, resources with MIME type
`text/html;profile=mcp-app` that the host renders in a sandboxed iframe next to the tool result.

- **Data passing.** The tool result carries the trace in `structuredContent` (`{ workspace, trace }`; not added to
  the model's context per the spec) and the text fallback in `content` (the `formatTrace` tree or the
  `formatServiceGraph` edge list), which is all a host without MCP Apps shows. The view gets the result through
  the MCP Apps bridge (`ontoolresult`); it never calls Ivy's API and has no token.
- **What goes into `structuredContent`.** The API's trace shape with payload attributes capped at 8 KB each (marked
  with the layer's `…[truncated N bytes]`, so the views show "truncated") and at most 2000 spans
  (`apps/view-trace.ts`). Payloads were redacted at ingest; nothing is sent that `get_trace_summary` with
  `detail: full` doesn't return.
- **No network.** The views are single HTML files with scripts, styles and service icons inlined; the resource
  declares empty `connectDomains`/`resourceDomains`, so the host's default CSP (`connect-src 'none'`) applies.
- **Views.** `packages/ui/src/mcp-apps/` renders the dashboard's own components: `Waterfall`, `SpanDetails`,
  `Logs`, `ErrorBlock`, `TraceGraph` (React Flow + dagre), `ServiceIcon`, the status badges. The waterfall view has
  Timeline and Logs tabs; failed calls start expanded; expanding a span shows its payloads, error, attributes
  and its own logs. Summary spans of collapsed calls and the "N spans omitted" note look as on the dashboard
  (`CollapsedBadge`, `OmittedSpansNote`; see `ui.md`). The graph view shows the trigger, functions and services; clicking a node lists its spans,
  each expandable to its details. Both show the workspace, function, status, duration, cold start and the
  invocation's error above, offer fullscreen when the host allows it (`requestDisplayMode`), resize to their
  content (auto-resize), and apply the host's safe-area insets.
- **Theme.** The views are always dark, like the dashboard. The spec makes the host theme a preference views may
  follow; a dark card reads fine in light hosts, so they draw their own rounded dark surface on a transparent page
  and set `prefersBorder: false`.
- **Build.** `pnpm --filter @ivy/ui build` builds the dashboard, then `build:mcp-apps` builds each view with
  `vite.mcp-apps.config.ts` and `vite-plugin-singlefile` into `dist/mcp-apps/{waterfall,graph}.html`. The build
  swaps `@/lib/spans/icon-url` for a version that inlines the icons from a virtual module
  (`mcp-apps/icons-plugin.ts`: minified SVG data URIs; the waterfall only gets the 16 px set). Sizes:
  waterfall 957 KB (266 KB gzipped), graph 1.23 MB (345 KB gzipped). About 450 KB of each (110 KB gzipped) is the
  ext-apps SDK and the MCP SDK's zod message schemas.
- **Serving.** The API reads the views from `<IVY_UI_DIR>/mcp-apps/` (`lib/mcp/views.ts`; re-read when the file
  changes). When a view is missing (API-only image, or `pnpm dev` before a UI build) its tool is registered as a
  plain text tool without `_meta.ui`, so it still works everywhere.
- **SDK version.** `@modelcontextprotocol/ext-apps` 1.7 is the line that works with `@modelcontextprotocol/sdk`
  1.x; ext-apps 2.x needs the split v2 SDK packages (`@modelcontextprotocol/server`). Moving to 2.x means moving
  the whole server to SDK v2.
- **Capability negotiation.** The server is stateless, so it can't see the client's `initialize` capabilities when
  answering a later request. The app tools are always registered with `_meta.ui`; hosts without MCP Apps ignore it
  and show `content`, as the spec intends.
- **Testing.** `apps/views.test.ts` checks the tool and resource metadata, the result shapes and the text-only
  fallback; the API's `mcp.test.ts` checks views are read from the UI dir. `pnpm --filter @ivy/ui mcp-apps:host`
  starts a local MCP Apps host (`/mcp-apps/host.html`, built on the SDK's `AppBridge`, proxying `/mcp` to
  `IVY_API_URL`, default `http://localhost:3000`): with a trace ID it calls the tool on the running API, reads the
  `ui://` resource and renders it in a sandboxed iframe like a real host; without one it renders the view from the
  dev server with a fixture trace (hot reload).

## OpenAPI

`packages/api/src/lib/openapi/{spec,schemas}.ts` is a hand-maintained OpenAPI 3.1 document of every `/api` route,
served at `GET /api/openapi.json` with a Scalar reference page at `GET /api/docs` (`@scalar/hono-api-reference`;
the page loads Scalar from its CDN). Both are public (`PUBLIC_ROUTES` in `lib/auth/middleware.ts`). Generating the
document from code would need zod schemas on every route; the API has none, and a test keeps the hand-written
document honest: `spec.test.ts` fails when a route is registered in `createApp` but missing from the document, or
the reverse, and when a `$ref` does not resolve.

Security scheme: `bearerAuth` (HTTP bearer, JWT from the OIDC issuer), noted as off on self-hosted setups without
OIDC; `eventSecret` for `POST /api/aws/events`; health, config, the document and the docs page are public.

## Mounting

`createApp` has one line for all of this: `mountAgentSurface(app, tenants, { uiDir })` (`src/lib/mcp/mount.ts`).
The only other changes to existing API code are `traceResponse(c, …)` in `routes/traces/get.ts`, which serves
`format=text`, the two public routes, and the `mcpClients` option of the verifier.

## Using it

```sh
claude mcp add --transport http ivy http://localhost:3000/mcp
curl 'http://localhost:3000/api/traces/<trace id>?format=text&detail=summary'
```
