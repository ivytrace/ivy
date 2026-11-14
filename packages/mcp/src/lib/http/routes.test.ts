import { checkoutFailed, checkoutOk, errorGroups, invocations, queueFailed, traces } from "@ivy/format/fixtures";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { InvocationQuery, IvyData } from "../data/types.js";
import { mcpRoutes } from "./routes.js";

function fakeData(calls: InvocationQuery[] = []): IvyData {
  return {
    async invocations(query) {
      calls.push(query);
      return invocations
        .filter((i) => !query.status || i.status === query.status)
        .filter((i) => !query.function || i.function === query.function)
        .filter((i) => !query.q || i.request_id === query.q || i.trace_id === query.q || i.error_message?.includes(query.q))
        .slice(0, query.limit);
    },
    async trace(id) {
      return traces.find((t) => t.trace_id === id) ?? null;
    },
    async errors(query) {
      return errorGroups.filter((g) => !query.function || g.function === query.function);
    },
  };
}

async function connect(app: Hono, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL("http://ivy.test/mcp"), {
    fetch: async (url, init) => app.request(url.toString(), init),
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) => ((result as CallToolResult).content[0] as { text: string }).text;

describe("MCP server", () => {
  it("lists the tools with schemas", async () => {
    const client = await connect(mcpRoutes({ data: () => fakeData() }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_invocations",
      "find_failing_invocations",
      "get_trace_summary",
      "list_error_groups",
      "search_invocations",
    ]);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    const summary = tools.find((t) => t.name === "get_trace_summary")!;
    expect(Object.keys(summary.inputSchema.properties ?? {})).toEqual(["trace_id", "request_id", "detail", "max_tokens"]);
  });

  it("find_failing_invocations lists failures as text", async () => {
    const calls: InvocationQuery[] = [];
    const client = await connect(mcpRoutes({ data: () => fakeData(calls) }));
    const text = textOf(await client.callTool({ name: "find_failing_invocations", arguments: { function: "checkout-createOrder" } }));
    expect(calls).toEqual([{ function: "checkout-createOrder", status: "error", since: "1h", limit: 20 }]);
    expect(text).toMatchInlineSnapshot(`
      "1 failed invocations of checkout-createOrder in the last 1h, newest first:
      2026-11-14T12:00:00Z ERROR checkout-createOrder 212ms cold POST /orders → 500 · TypeError: Cannot read properties of undefined (reading 'id') · trace 6af84d409a1b2c3d4e5f60718293a4b5"
    `);
  });

  it("search_invocations passes filters through", async () => {
    const calls: InvocationQuery[] = [];
    const client = await connect(mcpRoutes({ data: () => fakeData(calls) }));
    const text = textOf(await client.callTool({ name: "search_invocations", arguments: { q: "conditional", status: "error", since: "7d", limit: 5 } }));
    expect(calls[0]).toEqual({ q: "conditional", function: undefined, status: "error", since: "7d", limit: 5 });
    expect(text).toContain("orders-processQueue");
    expect(text).not.toContain("checkout-createOrder");
  });

  it("get_trace_summary renders the trace by trace ID or request ID", async () => {
    const client = await connect(mcpRoutes({ data: () => fakeData() }));
    const byTrace = textOf(await client.callTool({ name: "get_trace_summary", arguments: { trace_id: checkoutFailed.trace_id } }));
    expect(byTrace).toContain("checkout-createOrder · API Gateway POST /orders → 500 · cold start · 212ms · ERROR");
    expect(byTrace).toContain("! TypeError: Cannot read properties of undefined (reading 'id')");

    const byRequest = textOf(
      await client.callTool({ name: "get_trace_summary", arguments: { request_id: "c0ffee00-1111-4222-8333-444455556666", detail: "summary" } }),
    );
    expect(byRequest).toContain(`trace ${queueFailed.trace_id}`);
    expect(byRequest).toContain("×8");
  });

  it("get_trace_summary reports missing traces as tool errors", async () => {
    const client = await connect(mcpRoutes({ data: () => fakeData() }));
    const result = (await client.callTool({ name: "get_trace_summary", arguments: { trace_id: "0".repeat(32) } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
    const neither = (await client.callTool({ name: "get_trace_summary", arguments: {} })) as CallToolResult;
    expect(neither.isError).toBe(true);
  });

  it("compare_invocations picks the latest successful run as baseline", async () => {
    const calls: InvocationQuery[] = [];
    const client = await connect(mcpRoutes({ data: () => fakeData(calls) }));
    const text = textOf(await client.callTool({ name: "compare_invocations", arguments: { trace_id: checkoutFailed.trace_id } }));
    expect(calls).toEqual([{ function: "checkout-createOrder", status: "ok", since: "7d", limit: 1 }]);
    expect(text).toContain("B is the latest successful invocation of checkout-createOrder.");
    expect(text).toContain(`trace ${checkoutOk.trace_id}`);
    expect(text).toContain("- only in B: DynamoDB.PutItem checkout-orders");
  });

  it("list_error_groups summarizes groups", async () => {
    const client = await connect(mcpRoutes({ data: () => fakeData() }));
    const text = textOf(await client.callTool({ name: "list_error_groups", arguments: { since: "24h", limit: 1 } }));
    expect(text.split("\n")[0]).toBe("2 error groups (49 failed invocations) in the last 24h, showing the top 1:");
    expect(text).toContain("42× checkout-createOrder");
  });

  it("rejects invalid arguments", async () => {
    const client = await connect(mcpRoutes({ data: () => fakeData() }));
    const result = (await client.callTool({ name: "find_failing_invocations", arguments: { since: "yesterday" } })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});

describe("MCP auth", () => {
  const auth = {
    resource: "https://ivytrace.dev/mcp",
    authorizationServers: ["https://auth.example.com"],
    verifier: {
      verify: async (token: string, { audience }: { audience: string }) =>
        token === "good" && audience === "https://ivytrace.dev/mcp" ? { sub: "user-1" } : null,
    },
  };

  it("serves protected resource metadata at both well-known paths", async () => {
    const app = mcpRoutes({ data: () => fakeData(), auth });
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app.request(path);
      expect(await res.json()).toEqual({
        resource: "https://ivytrace.dev/mcp",
        authorization_servers: ["https://auth.example.com"],
        bearer_methods_supported: ["header"],
        resource_name: "Ivy",
        resource_documentation: "https://ivytrace.dev/api/docs",
      });
    }
  });

  it("answers 401 with resource_metadata without a valid token", async () => {
    const app = mcpRoutes({ data: () => fakeData(), auth });
    const missing = await app.request("/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ivytrace.dev/.well-known/oauth-protected-resource/mcp"',
    );
    const invalid = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer bad" } });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("accepts a token for the MCP audience and hands the user on", async () => {
    const users: string[] = [];
    const app = mcpRoutes({ data: () => fakeData(), auth, onAuthenticated: (_c, user) => users.push(user.sub) });
    const client = await connect(app, { authorization: "Bearer good" });
    expect((await client.listTools()).tools).toHaveLength(5);
    expect(users.length).toBeGreaterThan(0);
  });

  it("has no metadata and no auth when auth is off", async () => {
    const app = mcpRoutes({ data: () => fakeData() });
    expect((await app.request("/.well-known/oauth-protected-resource")).status).toBe(404);
  });
});
