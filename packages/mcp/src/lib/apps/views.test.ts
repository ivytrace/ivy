import { checkoutFailed, queueFailed } from "@ivy/format/fixtures";
import type { Trace } from "@ivy/spans";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { IvyData, Workspace } from "../data/types.js";
import { mcpRoutes } from "../http/routes.js";
import { MAX_ATTRIBUTE_CHARS, viewTrace } from "./view-trace.js";
import type { ViewHtml } from "./views.js";

const ws: Workspace = { id: "ten_prod", name: "Shop production", slug: "shop-production" };
const data: IvyData = {
  workspaces: async () => [ws],
  invocations: async () => [],
  trace: async (_w, id) => [checkoutFailed, queueFailed].find((t) => t.trace_id === id) ?? null,
  errors: async () => [],
};
const HTML: ViewHtml = { waterfall: "<!doctype html><title>waterfall</title>", graph: "<!doctype html><title>graph</title>" };

async function connect(views?: ViewHtml) {
  const app = mcpRoutes({ data: () => data, views: views && (() => views) });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://ivy.test/mcp"), { fetch: async (url, init) => app.request(url.toString(), init) }),
  );
  return client;
}

describe("MCP Apps tools", () => {
  it("links render_waterfall and render_graph to their ui:// views", async () => {
    const client = await connect(HTML);
    const { tools } = await client.listTools();
    for (const [name, uri] of [
      ["render_waterfall", "ui://ivy/waterfall.html"],
      ["render_graph", "ui://ivy/graph.html"],
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool._meta).toMatchObject({ ui: { resourceUri: uri } });
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["workspace", "trace_id"]);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("serves the views as MCP Apps resources without network access", async () => {
    const client = await connect(HTML);
    const { resources } = await client.listResources();
    expect(resources.map((r) => [r.uri, r.mimeType])).toEqual([
      ["ui://ivy/waterfall.html", "text/html;profile=mcp-app"],
      ["ui://ivy/graph.html", "text/html;profile=mcp-app"],
    ]);
    const read = await client.readResource({ uri: "ui://ivy/graph.html" });
    expect(read.contents).toEqual([
      {
        uri: "ui://ivy/graph.html",
        mimeType: "text/html;profile=mcp-app",
        text: HTML.graph,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
      },
    ]);
  });

  it("returns the text fallback in content and the trace for the view in structuredContent", async () => {
    const client = await connect(HTML);
    const waterfall = (await client.callTool({ name: "render_waterfall", arguments: { trace_id: checkoutFailed.trace_id } })) as CallToolResult;
    const text = (waterfall.content[0] as { text: string }).text;
    expect(text.split("\n")[0]).toBe("[shop-production]");
    expect(text).toContain("checkout-createOrder · API Gateway POST /orders → 500 · cold start · 212ms · ERROR");
    expect(waterfall.structuredContent).toEqual({
      workspace: { id: "ten_prod", slug: "shop-production", name: "Shop production" },
      trace: { ...checkoutFailed, omitted_spans: 0 },
    });

    const graph = (await client.callTool({ name: "render_graph", arguments: { trace_id: queueFailed.trace_id } })) as CallToolResult;
    expect((graph.content[0] as { text: string }).text).toContain("orders-processQueue → checkout-orders [DynamoDB UpdateItem, 12.9ms] ERROR");
  });

  it("falls back to plain text tools when the views are not built", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "render_waterfall")!;
    expect(tool._meta?.ui).toBeUndefined();
    const result = (await client.callTool({ name: "render_waterfall", arguments: { trace_id: checkoutFailed.trace_id } })) as CallToolResult;
    expect(result.structuredContent).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("[invocation]");
    expect((await client.listResources().catch(() => ({ resources: [] }))).resources).toEqual([]);
  });

  it("reports unknown traces as tool errors", async () => {
    const client = await connect(HTML);
    const result = (await client.callTool({ name: "render_graph", arguments: { trace_id: "0".repeat(32) } })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});

describe("viewTrace", () => {
  it("caps large payloads with the layer's truncation marker", () => {
    const big = "x".repeat(MAX_ATTRIBUTE_CHARS + 100);
    const trace: Trace = { ...checkoutFailed, spans: [{ ...checkoutFailed.spans[0], attributes: { "ivy.payload.request": `${big}…[truncated 50 bytes]` } }] };
    const span = viewTrace(trace).spans[0];
    expect(span.attributes["ivy.payload.request"]).toBe(`${"x".repeat(MAX_ATTRIBUTE_CHARS)}…[truncated 150 bytes]`);
    expect(span.attributes["ivy.payload.truncated"]).toBe("true");
  });
});
