# AI-native surface: MCP, text traces, OpenAPI

How agents use Ivy (milestone M5). Three ways in, all on the API server:

- **Remote MCP server** at `/mcp`: five read-only tools that answer in compact text.
- **`GET /api/traces/:traceId?format=text`**: one trace as an LLM-friendly text tree.
- **HTTP API** described by an OpenAPI 3.1 document at `/api/openapi.json`, browsable at `/api/docs`.

**No CLI.** The spec planned a CLI that mirrors the MCP tools. We dropped it: agents already speak MCP or
HTTP, so a CLI would be a third copy of the same queries to maintain.

## Packages

| package | what |
|---|---|
| `@ivy/spans` | Span types, API response types and the service-aware span describers (`describeSpan`, `getException`, …). Moved out of the UI so the UI and the formatter share them; `packages/ui/src/lib/spans/{services,types}.ts` re-export it. |
| `@ivy/format` | Pure text renderers: `formatTrace`, `formatInvocations`/`formatInvocationLine`, `formatErrorGroups`, `compareTraces`. Snapshot tests on fixtures in `src/lib/fixtures/traces.ts` (also exported as `@ivy/format/fixtures`). |
| `@ivy/mcp` | The MCP server (`createIvyMcpServer`), its tools, bearer auth and the Hono routes (`mcpRoutes`). Knows nothing about ClickHouse: it reads through an `IvyData` interface. |

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

## MCP server

Streamable HTTP, **stateless** (`sessionIdGenerator: undefined`) with JSON responses (`enableJsonResponse`): every
POST builds a fresh `McpServer` and transport. Nothing to keep in memory, and it works behind any load balancer.
GET (server-sent streams) is not supported; none of the tools need server-initiated messages.

### Tools

All read-only (`readOnlyHint`), with zod input schemas (published as JSON Schema). Outputs are text.
Time ranges are `since` values like `15m`, `1h`, `24h`, `7d`, as in the API.

| tool | input | output |
|---|---|---|
| `find_failing_invocations` | `function?`, `since` (1h), `limit` (20, max 100) | Count line, then one line per failed invocation (`formatInvocationLine`), newest first. |
| `search_invocations` | `q?`, `function?`, `status?`, `since` (24h), `limit` (20) | Same lines. `q` is the API's free text (request/trace ID exact, error message or path substring). |
| `get_trace_summary` | `trace_id` or `request_id`, `detail` (normal), `max_tokens` (2000) | `formatTrace`. A request ID is looked up over the last 7 days. |
| `compare_invocations` | `trace_id`, `baseline_trace_id?`, `max_tokens` | `compareTraces`. Without a baseline: the latest successful invocation of the same function in the last 7 days. |
| `list_error_groups` | `function?`, `since` (24h), `limit` (20) | Totals line, then `count× function · type: message · first … · last … · sample trace …`. |

Errors (unknown trace, invalid range) come back as tool results with `isError: true` and a sentence saying what
to do next, not as protocol errors, so the model can recover.

### Data access and tenancy

The tools read through `IvyData` (`invocations`, `trace`, `errors`). The API implements it in
`packages/api/src/lib/mcp/data.ts` by running its **own route handlers** (`getInvocations`, `getTrace`, `getErrors`)
in-process on a small internal Hono app, with the tenant the `/mcp` request resolved. So the tools use the same
SQL, the same parameter validation and the same `dataQuery` tenant guard as the HTTP API, without HTTP calls to
itself and without moving query code out of the route files. `mcp.test.ts` calls every tool against a fake
ClickHouse and checks that each query binds the request tenant.

`/mcp` runs `tenantContext(resolver)`, the same middleware and resolver as `/api/*`, after the bearer check.

### Auth (MCP authorization spec)

The MCP endpoint is an OAuth 2.1 protected resource:

- `GET /.well-known/oauth-protected-resource` and the path-suffixed `/.well-known/oauth-protected-resource/mcp`
  (RFC 9728) return `{ resource, authorization_servers: [IVY_OIDC_ISSUER], bearer_methods_supported: ["header"],
  resource_name, resource_documentation }`.
- `resource` is the canonical MCP URL: `IVY_MCP_RESOURCE` (e.g. `https://ivytrace.dev/mcp`), else
  `IVY_PUBLIC_URL` + `/mcp`.
- No or invalid token: 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`
  (plus `error="invalid_token"` when a token was sent). Clients discover the authorization server from there.
- Tokens for the MCP carry `aud` = the MCP resource; `/mcp` accepts only those. Tokens with the API audience are
  for `/api` (the OIDC middleware) and are rejected on `/mcp`, and the reverse: no token passthrough.
- The verified user goes on the context as `mcpUser` for the tenant resolver.
- Without `IVY_OIDC_ISSUER` the endpoint is open and there is no metadata (404), like the API on self-hosted setups.
  With an issuer but no resource URL, startup fails.

`@ivy/mcp` checks tokens through a small interface, `TokenVerifier.verify(token, { audience }) → user | null`.

#### Wiring the verifier (TODO at the OIDC merge)

The JWT verifier (issuer discovery, JWKS, `iss`/`exp`/`aud` checks) is built on the OIDC branch in
`packages/api/src/lib/auth/*`. Until it is merged, `packages/api/src/lib/mcp/auth.ts` uses `pendingVerifier`, which
rejects every token, so an endpoint with OIDC configured fails closed. At merge time:

1. Pass an adapter over the OIDC verifier to `mountAgentSurface(app, tenants, verifier)` in `app.ts` (or make it the
   default in `mcpAuthFromEnv`), verifying with `audience: IVY_MCP_RESOURCE`.
2. Have the tenant resolver read the MCP user (`c.get('mcpUser')`) the same way it reads the API user, or set the
   same context key the OIDC middleware uses in `rememberMcpUser`.
3. Make sure the OIDC bearer middleware on `/api/*` leaves `/api/openapi.json` and `/api/docs` public (they are
   registered before the tenant middleware for that reason) and does not run on `/mcp`.
4. Fill `scopes_supported` in the metadata if the authorization server defines scopes for Ivy.

#### What the authorization server must support for MCP clients

- OAuth 2.0 Authorization Server Metadata (RFC 8414) or OIDC discovery at the issuer.
- Authorization code flow with PKCE (S256) for public clients.
- Dynamic Client Registration (RFC 7591), since MCP clients (Claude, IDEs) register themselves; alternatively
  Client ID Metadata Documents.
- Resource indicators (RFC 8707): honour the `resource` parameter and issue access tokens with
  `aud` = `IVY_MCP_RESOURCE` (`https://ivytrace.dev/mcp`), distinct from the API audience.
- Redirect URIs on `http://localhost:<port>` / `http://127.0.0.1` (any port) for local clients, and HTTPS callbacks
  for hosted ones.
- Refresh tokens, so agents keep working past the access token lifetime.

## OpenAPI

`packages/api/src/lib/openapi/{spec,schemas}.ts` is a hand-maintained OpenAPI 3.1 document of every `/api` route,
served at `GET /api/openapi.json` with a Scalar reference page at `GET /api/docs` (`@scalar/hono-api-reference`;
the page loads Scalar from its CDN). Generating it from code would need zod schemas on every route; the API has
none, and a test keeps the hand-written document honest: `spec.test.ts` fails when a route is registered in
`createApp` but missing from the document, or the reverse, and when a `$ref` does not resolve.

Security scheme: `bearerAuth` (HTTP bearer, JWT from the OIDC issuer), noted as off on self-hosted setups without
OIDC; `eventSecret` for `POST /api/aws/events`; health, config, the document and the docs page are public.

## Mounting

`createApp` has one line for all of this: `mountAgentSurface(app, resolver)` (`src/lib/mcp/mount.ts`), called
before the `/api/*` tenant middleware. The only other change to existing API code is `traceResponse(c, …)` in
`routes/traces/get.ts`, which serves `format=text`.

## Using it

```sh
claude mcp add --transport http ivy http://localhost:3000/mcp
curl 'http://localhost:3000/api/traces/<trace id>?format=text&detail=summary'
```
