import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bearerAuth, protectedResourceMetadata, type AuthUser, type McpAuth } from "../auth/auth.js";
import type { IvyData } from "../data/types.js";
import { createIvyMcpServer } from "../server/server.js";

export interface McpRoutesOptions {
  /** Data access for one request; called after auth and `middleware`, so it can read the tenant from the context. */
  data: (c: Context) => IvyData;
  /** OAuth protected resource settings. Without it the endpoint is open (self-hosted without OIDC). */
  auth?: McpAuth;
  /** Called with the verified user, e.g. to put it on the context for the tenant resolver. */
  onAuthenticated?: (c: Context, user: AuthUser, token: string) => void;
  /** Runs after auth, before the MCP handler (e.g. tenant resolution). */
  middleware?: MiddlewareHandler[];
  /** Mount path of the endpoint (default `/mcp`). */
  path?: string;
  version?: string;
}

/**
 * Hono routes for Ivy's remote MCP server: Streamable HTTP in stateless JSON mode at `path`, plus the
 * RFC 9728 metadata documents when auth is on. Mount with `app.route("/", mcpRoutes(…))`.
 */
export function mcpRoutes(options: McpRoutesOptions): Hono {
  const path = options.path ?? "/mcp";
  const app = new Hono();

  if (options.auth) {
    const metadata = protectedResourceMetadata(options.auth);
    app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata));
    app.get(`/.well-known/oauth-protected-resource${path}`, (c) => c.json(metadata));
    app.use(path, bearerAuth(options.auth, options.onAuthenticated));
  }
  for (const middleware of options.middleware ?? []) app.use(path, middleware);

  app.all(path, async (c) => {
    const server = createIvyMcpServer(options.data(c), options.version);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
