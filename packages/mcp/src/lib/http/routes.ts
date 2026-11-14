import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bearerAuth, protectedResourceMetadata, type AuthUser, type McpAuth } from "../auth/auth.js";
import type { ViewHtml } from "../apps/views.js";
import type { IvyData } from "../data/types.js";
import { createIvyMcpServer } from "../server/server.js";

export interface McpRoutesOptions<U extends AuthUser = AuthUser> {
  /** Data access for one request; called after auth and `middleware`, so it can read the user from the context. */
  data: (c: Context) => IvyData;
  /** OAuth protected resource settings. Without it the endpoint is open (self-hosted without OIDC). */
  auth?: McpAuth<U>;
  /** Called with the verified user, e.g. to put it on the context for workspace resolution. */
  onAuthenticated?: (c: Context, user: U, token: string) => void;
  /** Runs after auth, before the MCP handler. */
  middleware?: MiddlewareHandler[];
  /** Mount path of the endpoint (default `/mcp`). */
  path?: string;
  version?: string;
  /** HTML of the MCP Apps views (read per request, so a later UI build is picked up). */
  views?: () => ViewHtml | Promise<ViewHtml>;
}

/**
 * Hono routes for Ivy's remote MCP server: Streamable HTTP in stateless JSON mode at `path`, plus the
 * RFC 9728 metadata documents when auth is on. Mount with `app.route("/", mcpRoutes(…))`.
 */
export function mcpRoutes<U extends AuthUser>(options: McpRoutesOptions<U>): Hono {
  const path = options.path ?? "/mcp";
  const app = new Hono();

  if (options.auth) {
    const metadata = protectedResourceMetadata(options.auth);
    app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata));
    app.get(`/.well-known/oauth-protected-resource${path}`, (c) => c.json(metadata));
    app.use(path, bearerAuth(options.auth, options.onAuthenticated));
  } else {
    // Without auth there is no metadata; answer 404 rather than letting the host's catch-all (e.g. the SPA) reply.
    const none = (c: Context) => c.json({ error: "Not found" }, 404);
    app.get("/.well-known/oauth-protected-resource", none);
    app.get("/.well-known/oauth-protected-resource/*", none);
  }
  for (const middleware of options.middleware ?? []) app.use(path, middleware);

  app.all(path, async (c) => {
    const views = (await options.views?.()) ?? {};
    const server = createIvyMcpServer(options.data(c), { version: options.version, views });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
