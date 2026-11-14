import { checkoutFailed, checkoutOk, errorGroups, invocations, queueFailed, throttledGroup } from "@ivy/format/fixtures";
import type { ErrorGroup, Invocation, Trace } from "@ivy/spans";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { InvocationQuery, IvyData, Workspace } from "../data/types.js";
import { mcpRoutes } from "./routes.js";

interface Seed {
  workspace: Workspace;
  invocations: Invocation[];
  traces: Trace[];
  errors: ErrorGroup[];
  broken?: boolean;
}

const prod: Seed = {
  workspace: { id: "ten_prod", name: "Shop production", slug: "shop-production" },
  invocations: [invocations[0], invocations[2]],
  traces: [checkoutFailed, checkoutOk],
  errors: [errorGroups[0]],
};
const staging: Seed = {
  workspace: { id: "ten_stg", name: "Staging", slug: "staging" },
  invocations: [invocations[1]],
  traces: [queueFailed],
  errors: [errorGroups[1], throttledGroup],
};
const broken: Seed = { workspace: { id: "ten_x", name: "Broken", slug: "broken" }, invocations: [], traces: [], errors: [], broken: true };

type Call = { workspace: string; method: string; query?: InvocationQuery };

function fakeData(seeds: Seed[], calls: Call[] = []): IvyData {
  const seed = (w: Workspace) => {
    const s = seeds.find((x) => x.workspace.id === w.id)!;
    if (s.broken) throw new Error("shard unavailable");
    return s;
  };
  return {
    workspaces: async () => seeds.map((s) => s.workspace),
    async invocations(w, query) {
      calls.push({ workspace: w.slug, method: "invocations", query });
      return seed(w)
        .invocations.filter((i) => !query.status || i.status === query.status)
        .filter((i) => !query.function || i.function === query.function)
        .filter((i) => !query.q || i.request_id === query.q || i.trace_id === query.q || i.error_message?.includes(query.q))
        .slice(0, query.limit);
    },
    async trace(w, id) {
      calls.push({ workspace: w.slug, method: "trace" });
      return seed(w).traces.find((t) => t.trace_id === id) ?? null;
    },
    async errors(w, query) {
      calls.push({ workspace: w.slug, method: "errors" });
      return seed(w).errors.filter((g) => !query.function || g.function === query.function);
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

async function call(seeds: Seed[], name: string, args: Record<string, unknown> = {}, calls?: Call[]) {
  const client = await connect(mcpRoutes({ data: () => fakeData(seeds, calls) }));
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("MCP server", () => {
  it("lists the tools with schemas", async () => {
    const client = await connect(mcpRoutes({ data: () => fakeData([prod]) }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_invocations",
      "find_failing_invocations",
      "get_trace_summary",
      "list_error_groups",
      "list_workspaces",
      "render_graph",
      "render_waterfall",
      "search_invocations",
    ]);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      if (tool.name !== "list_workspaces") expect(tool.inputSchema.properties).toHaveProperty("workspace");
    }
    const summary = tools.find((t) => t.name === "get_trace_summary")!;
    expect(Object.keys(summary.inputSchema.properties ?? {})).toEqual(["workspace", "trace_id", "request_id", "detail", "max_tokens"]);
  });

  it("list_workspaces lists slug, name and ID", async () => {
    expect(textOf(await call([prod, staging], "list_workspaces"))).toBe(
      "2 workspaces:\nshop-production · Shop production · ten_prod\nstaging · Staging · ten_stg",
    );
  });

  it("find_failing_invocations merges all workspaces newest first, labelled", async () => {
    const calls: Call[] = [];
    const text = textOf(await call([prod, staging], "find_failing_invocations", {}, calls));
    expect(calls.map((c) => [c.workspace, c.query])).toEqual([
      ["shop-production", { function: undefined, status: "error", since: "1h", limit: 20 }],
      ["staging", { function: undefined, status: "error", since: "1h", limit: 20 }],
    ]);
    expect(text).toMatchInlineSnapshot(`
      "2 failed invocations in 2 workspaces, last 1h, newest first:
      [staging] 2026-11-14T12:00:05Z ERROR orders-processQueue 96.3ms sqs · ConditionalCheckFailedException: The conditional request failed · trace 6af84d4577aa88bb99cc00dd11ee22ff
      [shop-production] 2026-11-14T12:00:00Z ERROR checkout-createOrder 212ms cold POST /orders → 500 · TypeError: Cannot read properties of undefined (reading 'id') · trace 6af84d409a1b2c3d4e5f60718293a4b5"
    `);
  });

  it("applies the combined limit and narrows to one workspace by slug or ID", async () => {
    const one = textOf(await call([prod, staging], "find_failing_invocations", { limit: 1 }));
    expect(one.split("\n")).toHaveLength(2);
    expect(one).toContain("more exist");

    const calls: Call[] = [];
    const scoped = textOf(await call([prod, staging], "search_invocations", { workspace: "TEN_STG", q: "conditional" }, calls));
    expect(calls.map((c) => c.workspace)).toEqual(["staging"]);
    expect(scoped).toContain("in workspace staging");

    const unknown = await call([prod, staging], "search_invocations", { workspace: "nope" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Yours: shop-production, staging");
  });

  it("returns the other workspaces when one fails, and says which", async () => {
    const result = await call([prod, broken, staging], "list_error_groups");
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchInlineSnapshot(`
      "3 error groups (49 failed invocations, 31 throttled requests without a trace) in 3 workspaces, last 24h:
      [shop-production] 42× checkout-createOrder · TypeError: Cannot read properties of undefined (reading 'id') · first 2026-11-14T08:12:44Z · last 2026-11-14T12:00:00Z · sample trace 6af84d409a1b2c3d4e5f60718293a4b5
      [staging] 31× orders-processQueue · Throttled: Lambda rejected these invocations, so they never reached the function and there is no trace · first 2026-11-14T11:40:00Z · last 2026-11-14T11:52:00Z
      [staging] 7× orders-processQueue · ConditionalCheckFailedException: The conditional request failed · first 2026-11-14T10:01:02Z · last 2026-11-14T12:00:05Z · sample trace 6af84d4577aa88bb99cc00dd11ee22ff

      Not included (query failed): broken (shard unavailable)"
    `);
    const allBroken = await call([broken], "list_error_groups");
    expect(allBroken.isError).toBe(true);
  });

  it("get_trace_summary finds the workspace holding the trace via the invocations index", async () => {
    const calls: Call[] = [];
    const text = textOf(await call([prod, staging], "get_trace_summary", { trace_id: queueFailed.trace_id }, calls));
    expect(text.split("\n")[0]).toBe("[staging]");
    expect(text).toContain("orders-processQueue · SQS · warm · 96.3ms · ERROR");
    const probes = calls.filter((c) => c.method === "invocations");
    expect(probes.map((c) => c.workspace)).toEqual(["shop-production", "staging"]);
    expect(probes[0].query).toMatchObject({ q: queueFailed.trace_id, from: "2026-11-14T11:00:05.000Z", to: "2026-11-14T13:00:05.000Z", limit: 1 });
    expect(calls.filter((c) => c.method === "trace").map((c) => c.workspace)).toEqual(["staging"]);
  });

  it("get_trace_summary looks up request IDs and reports missing traces as tool errors", async () => {
    const byRequest = textOf(await call([prod, staging], "get_trace_summary", { request_id: "c0ffee00-1111-4222-8333-444455556666", detail: "summary" }));
    expect(byRequest).toContain(`trace ${queueFailed.trace_id}`);
    expect(byRequest).toContain("×8");

    const missing = await call([prod, staging], "get_trace_summary", { trace_id: "0".repeat(32) });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("not found in any of your 2 workspaces");
    expect((await call([prod], "get_trace_summary", {})).isError).toBe(true);
  });

  it("compare_invocations picks the latest successful run in the same workspace", async () => {
    const calls: Call[] = [];
    const text = textOf(await call([staging, prod], "compare_invocations", { trace_id: checkoutFailed.trace_id }, calls));
    expect(calls.filter((c) => c.query?.status === "ok")).toEqual([
      { workspace: "shop-production", method: "invocations", query: { function: "checkout-createOrder", status: "ok", since: "7d", limit: 1 } },
    ]);
    expect(text.split("\n").slice(0, 2)).toEqual(["[shop-production]", "B is the latest successful invocation of checkout-createOrder."]);
    expect(text).toContain(`trace ${checkoutOk.trace_id}`);
    expect(text).toContain("- only in B: DynamoDB.PutItem checkout-orders");
  });

  it("rejects invalid arguments", async () => {
    expect((await call([prod], "find_failing_invocations", { since: "yesterday" })).isError).toBe(true);
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
    const app = mcpRoutes({ data: () => fakeData([prod]), auth });
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
    const app = mcpRoutes({ data: () => fakeData([prod]), auth });
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
    const app = mcpRoutes({ data: () => fakeData([prod]), auth, onAuthenticated: (_c, user) => users.push(user.sub) });
    const client = await connect(app, { authorization: "Bearer good" });
    expect((await client.listTools()).tools).toHaveLength(8);
    expect(users.length).toBeGreaterThan(0);
  });

  it("has no metadata and no auth when auth is off", async () => {
    const app = mcpRoutes({ data: () => fakeData([prod]) });
    expect((await app.request("/.well-known/oauth-protected-resource")).status).toBe(404);
    expect((await app.request("/.well-known/oauth-protected-resource/mcp")).status).toBe(404);
    const client = await connect(app);
    expect((await client.listTools()).tools).toHaveLength(8);
  });
});
