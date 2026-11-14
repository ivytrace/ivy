# Authentication

Spec M3: hosted uses Includable Auth, self-hosted can use any OIDC provider, and without OIDC the dashboard, API
and MCP run without auth (for setups behind an authenticating proxy). Ivy has exactly two modes: **no auth** or
**OIDC**. There are no passwords and no basic auth. Ingest is separate and always uses API keys (`tenancy.md`).

## Configuration

| variable | default | |
|---|---|---|
| `IVY_OIDC_ISSUER` | | Issuer URL. Unset means auth is off. |
| `IVY_OIDC_CLIENT_ID` | | The dashboard's client: public, authorization code + PKCE, redirect URI `<origin>/auth/callback`, post-logout redirect `<origin>/`. Required when the issuer is set (the API refuses to start without it). |
| `IVY_OIDC_AUDIENCE` | the client ID | Expected `aud` of access tokens: the API's resource identifier at the provider. |
| `IVY_OIDC_SCOPES` | `openid email profile offline_access` | Scopes the UI requests. `offline_access` gets a refresh token. |
| `IVY_OIDC_ALLOW_AGENTS` | `true` | Accept tokens of coding agents registered under the client (see below). |
| `IVY_SINGLE_TENANT` | `1` | Tenant mapping, see "Users and tenants". |

`GET /api/config` returns the public part, so the UI configures itself at runtime and one image serves every
deployment:

```json
{ "version": "0.1.0", "auth": { "enabled": true, "issuer": "https://auth.includable.com", "clientId": "ivy",
  "audience": "https://ivytrace.dev/api", "scopes": "openid email profile offline_access" } }
```

With auth off it is `{ "enabled": false }`, and the UI shows the persistent "Authentication disabled" banner.

### Hosted (Includable Auth)

```sh
IVY_OIDC_ISSUER=https://auth.includable.com
IVY_OIDC_CLIENT_ID=ivy
IVY_OIDC_AUDIENCE=https://ivytrace.dev/api
IVY_SINGLE_TENANT=0
```

The `ivy` client in Includable Auth has redirect URIs `https://ivytrace.dev/auth/callback`,
`http://localhost:3000/auth/callback` and `http://localhost:5173/auth/callback`, post-logout redirects to `/` on the same
origins, resource `https://ivytrace.dev/api`, sign-up on and agent registration on. Local development against it
therefore only works on ports 3000 (built UI) and 5173 (Vite).

### Self-hosted

Register a public SPA client with your provider (Keycloak, Auth0, Okta, Entra ID, Authentik, Zitadel, Google
Workspace through one of those, …), with the redirect URIs above, and an API/resource whose access tokens are JWTs with
that audience. Notes per provider:

- The UI sends the audience both as `resource` (RFC 8707: Includable Auth, Keycloak, Okta, …) and as `audience`
  (Auth0). Providers ignore parameters they don't know.
- The API needs JWT access tokens. Providers that only issue opaque access tokens (plain Google OAuth) don't work
  directly; put Keycloak, Dex or Authentik in front.
- Refresh tokens need `offline_access` (or the provider's equivalent). Without one, the user signs in again when the
  access token expires.

## API

`packages/api/src/lib/auth/`:

- `config.ts`: reads the variables above (`readAuthConfig()`, null when auth is off).
- `verify.ts`: `verifyAccessToken(token, { audience? })`, a jose-based verifier. It is generic, not tied to
  Includable Auth.
- `middleware.ts`: `authenticate()`, mounted on `/api/*` only.
- `user.ts`: the `AuthUser` type and `authUser(c)`.

### Token rules

1. Discovery: `<issuer>/.well-known/openid-configuration` is fetched once. Its `issuer` must match the configured issuer
   (a trailing slash is ignored), and its `jwks_uri` is used. jose caches the JWKS and refetches it when a token has an
   unknown `kid` (key rotation). A failed discovery is retried on the next request.
2. Signature against that JWKS. jose's defaults apply: asymmetric algorithms from the JWK, never `none` or HMAC.
3. `iss` equals the discovered issuer. `aud` contains `IVY_OIDC_AUDIENCE`, or the `audience` the caller passes.
   `exp` is required and checked with 30 s of clock tolerance (also for `nbf`/`iat`). `sub` is required.
4. Client: the token's client (`client_id`, RFC 9068 and Includable Auth; else `azp`, used by Auth0, Keycloak and
   Entra v2; else `cid` for Okta, `appid` for Entra v1) must be the configured client ID, or, with agents allowed,
   start with `agt_<clientId>_` and not name another parent in `parent_client_id`. A token without any client claim is
   refused. This keeps tokens that other clients obtained for the same API (machine-to-machine clients, other apps)
   out.

Errors: missing token → 401 `{"error":"Authentication required"}` + `WWW-Authenticate: Bearer`. Invalid, expired,
wrong audience, issuer or client → 401 with `WWW-Authenticate: Bearer error="invalid_token"`. Provider unreachable
while fetching discovery or keys → 503.

### Which routes

With OIDC on, `authenticate()` runs on every `/api/*` request except:

| route | why |
|---|---|
| `GET /api/health` | liveness, no data |
| `GET /api/config` | the UI needs it before sign-in |
| `POST /api/aws/events` | EventBridge webhook, authenticated by its per-connection `x-ivy-event-secret` |
| `OPTIONS *` | preflight |

Everything else needs a token, including unknown `/api` paths (401 before 404) and `GET /api/aws/template.yaml`,
which contains a connection's external ID and event secret. The UI downloads that with its token instead of a plain
link. `/mcp` and `/.well-known/*` are not under the middleware: the MCP server checks its own tokens with
`verifyAccessToken(token, { audience: IVY_MCP_RESOURCE })` and answers 401 with its own `resource_metadata` header.

### The caller on the context

```ts
import { authUser } from './lib/auth/user.js';

const user = authUser(c); // AuthUser | null (null: auth off, or a public route)
user.sub;                 // the provider's subject, e.g. "idn_…"; the key for mapping users to tenants
user.email; user.name;    // when the access token has them (Includable access tokens may not)
user.clientId;            // "ivy" or "agt_ivy_…"
user.agent;               // { clientId, name } for a coding agent, null for the person
```

## Coding agents

Includable Auth lets AI coding agents register themselves under the `ivy` client (RFC 7591 registration plus the
device flow; see Includable Auth's `agent-auth.md`). Their client IDs look like `agt_ivy_<nanoid>`, and their access
tokens have the same issuer and audience as the dashboard's, with `parent_client_id: "ivy"` and the agent's
self-chosen `client_name`. Ivy accepts them (unless `IVY_OIDC_ALLOW_AGENTS=false`), acting as the person who approved
the agent (same `sub`, so the same tenant), and records `agent: { clientId, name }` on the context. The name is the
agent's own claim and isn't verified, so it's only good for display and audit. Signing out of the dashboard doesn't end
an agent's access; removing the agent at Includable Auth does (its refresh token stops working, and the access token it
holds expires within the hour).

The rule is the same one `@includable/auth`'s `createAuthServer({ allowAgents: true })` applies, extended to
`azp`. The SDK itself isn't used on the API: it is fixed to Includable's JWKS path and `typ: at+jwt`/RS256 tokens,
while Ivy must work with any provider.

## UI

`packages/ui/src/lib/auth/`, using **oidc-client-ts** (authorization code + PKCE).

Why oidc-client-ts and not the `@includable/auth` browser client: Ivy has to work with any provider. oidc-client-ts is
the standard certified OIDC client for SPAs, works from discovery for any issuer, and has refresh-token renewal,
`end_session` sign-out, `resource` and arbitrary extra parameters. The Includable client takes an `issuer` too, but it
is built around Includable Auth: its identity API, its storage keys and its screens. The few Includable-specific bits
Ivy needs (`screen=signup`, `login_hint`) are plain authorization parameters.

- `provider.tsx`: `AuthProvider` reads `/api/config`. With auth on, it creates the client, attaches tokens to every API
  call (`setAuthHooks` in `lib/api/client.ts`), and tracks the session. `useAuth()` returns
  `{ status: "loading" | "disabled" | "signed-out" | "signed-in", user, client }`.
- `client.ts`: the wrapper. The session is stored in localStorage, so it is shared by tabs and survives reloads.
  Tokens are renewed with the refresh token shortly before they expire (`automaticSilentRenew`), and on demand when a
  request finds the token already expired. If renewal fails, the session is dropped.
- `return-to.ts`: `safeReturnTo` only allows a path on this origin (no `//host`, `/\host`, absolute URLs, control
  characters, or the auth routes themselves). Otherwise it returns `/`.

Routes (outside the app layout, so no menu or banner):

| route | |
|---|---|
| `/login?returnTo=&login_hint=&screen=signup` | Starts sign-in at the provider. `login_hint` fills in the email. `screen=signup` opens Includable Auth's sign-up screen; other providers ignore it. Already signed in, or auth off: goes straight to `returnTo`. |
| `/auth/callback` | Exchanges the code, sets the marker cookie and continues on the stored `returnTo` (carried in the OIDC `state`). On failure: an error with "Sign in again". |
| `/logout` | Clears the marker cookie and the local session, then signs out at the provider (`end_session_endpoint` with `id_token_hint`), which returns to `/`. Without an end-session endpoint it just goes to `/`. |

Every app route sits behind `RequireAuth`. Signed out, it redirects to `/login?returnTo=<current path + query + hash>`.
A 401 from the API (an expired or revoked session) drops the local session and does the same. The header has a small
user menu with the email (or name, or `sub`) and "Sign out".

The banner shows only with auth off. The user menu shows only when signed in. Both use the existing dark palette.

## Marker cookie: `ivy_session`

On ivytrace.dev, the website and the app share one domain. CloudFront will route signed-in visitors at `/` to the app
and everyone else to the website, which needs a signal at the edge. The session itself lives in localStorage, which
CloudFront can't see. So the UI sets:

```
ivy_session=1; Path=/; SameSite=Lax; Max-Age=2592000; Secure   (Secure only on https)
```

- It is set at `/auth/callback` after a successful sign-in. It is cleared (`Max-Age=0`) on sign-out, when a 401 drops
  the session, and when the session is removed after a failed renewal.
- Max-Age is 30 days, the lifetime of an Includable Auth refresh token. Refresh tokens rotate but keep their original
  expiry, so the cookie lapses about when the session can no longer be renewed.
- **It carries no token and grants nothing.** It's not HttpOnly because the SPA writes it. A forged or stale cookie
  only means the visitor lands on the app, which sends them to sign in. The API never reads it.

### What hosted CloudFront needs

- `/` (exact path): with cookie `ivy_session=1`, forward to the app (the API origin serving the UI's `index.html`).
  Without it, serve the website. This needs a CloudFront Function on viewer-request, and the cookie must be in the
  cache key (or the response marked uncacheable) for `/`.
- Always to the app (API origin): `/api/*`, `/mcp*`, `/.well-known/oauth-protected-resource*` (MCP), `/assets/*`
  (UI bundles), and the SPA routes `/login`, `/auth/callback`, `/logout`, `/functions*`, `/invocations*`, `/traces/*`,
  `/errors*`, `/settings*`.
- Everything else goes to the website.

## Users and tenants

`packages/api/src/lib/tenancy/members.ts`. The tenant resolver (`userTenantResolver`, the default in `createApp`):

- Auth off: every request is `default`.
- Auth on, `IVY_SINGLE_TENANT` unset or `1` (the default, meant for self-hosting): every signed-in user is `default`.
  One install is one team, and access is decided by who can sign in at the provider.
- Auth on, `IVY_SINGLE_TENANT=0` (hosted): the user's tenant comes from `ivy_control.tenant_members`
  (`tenant_id, sub, email, role, created_at`). With several memberships, the oldest wins until there is a tenant picker.
  On the first request from an unknown `sub`, Ivy creates a tenant (name: the email, else the name, else the `sub`) and
  makes the user its `owner`.

The new tenant's ID is `ten_` plus 21 base62 characters of `sha256("ivy-tenant:" + sub)`, not random. Concurrent first
requests, whether in one process (also de-duplicated in memory) or in several API processes, compute the same tenant
and write the same membership row, and the ReplacingMergeTree tables collapse duplicates. An agent token carries its
person's `sub`, so it maps to the same tenant. The mapping is cached in memory for 60 s, and tenant → shard for 30 s
(`context.ts`).

## Verification

- `lib/auth/middleware.test.ts`: a locally generated RSA key, a JWKS and discovery served by a stubbed `fetch`. Covers
  auth off, `/api/config` in both modes, public routes, missing/basic credentials, valid tokens (`client_id` and
  `azp`), expired, clock skew, wrong audience, wrong issuer, wrong key, garbage, agents (`client_id`/`azp`, turned off,
  another parent), unrelated clients, per-call audience (MCP), discovery caching and an unreachable provider (503).
- `app.test.ts`: with OIDC set, the real app answers 401 on data routes and the template, and serves `/api/config`.
- `lib/tenancy/members.test.ts`: tenant creation and ownership, existing memberships, agents, concurrent first requests,
  two "processes", single-tenant mode, and the resolver with auth on and off.
- UI `lib/auth/return-to.test.ts`: `returnTo` sanitising, `/login` URLs and the marker cookie string.
- Against the real Includable Auth (API on :3100 and Vite on :5180, because :3000 and :5173 were taken):
  `/api/config` shows the settings, `/api/functions` answers 401 without a token, and a forged token gets
  `Invalid access token` (so discovery and JWKS from auth.includable.com worked). Opening `/invocations?status=error`
  redirected to `https://auth.includable.com/auth` with `client_id=ivy`, PKCE S256, `resource` and `audience`, and
  Includable showed its Ivy-branded page. On :5180 that page was `invalid_redirect_uri`, as expected for an
  unregistered port. The same request with the registered `http://localhost:5173/auth/callback` (plus `login_hint` and
  `screen=signup`) was accepted. The browser already had an Includable session, so it went straight back to :5173 with
  a code, where another dev server without this branch was running. The code exchange and token use in the browser
  were not tested end to end.
