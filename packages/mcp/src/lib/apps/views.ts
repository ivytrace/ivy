import { formatServiceGraph, formatTrace } from "@ivy/format";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IvyData } from "../data/types.js";
import { guarded, label, READ_ONLY, traceId, workspace } from "../tools/common.js";
import { findTrace, type FoundTrace } from "../tools/traces.js";
import { viewTrace } from "./view-trace.js";

/** Built single-file HTML of each view (packages/ui `build:mcp-apps`); null when not built. */
export interface ViewHtml {
  waterfall?: string | null;
  graph?: string | null;
}

export const VIEW_URIS = {
  waterfall: "ui://ivy/waterfall.html",
  graph: "ui://ivy/graph.html",
} as const;

type ViewName = keyof typeof VIEW_URIS;

interface ViewTool {
  view: ViewName;
  tool: string;
  title: string;
  description: string;
  text: (found: FoundTrace) => string;
}

const TOOLS: ViewTool[] = [
  {
    view: "waterfall",
    tool: "render_waterfall",
    title: "Show trace waterfall",
    description:
      "Show the span waterfall of one trace to the user as an interactive view, like the Timeline tab of Ivy's trace " +
      "page: a bar per span on a shared time axis with service icons and durations, failed spans in red, and each span " +
      "expandable to its request and response payloads, error and attributes. Use it when the user wants to see a trace. " +
      "The trace is found in whichever of your workspaces holds it unless you pass workspace. You also get the text tree " +
      "of get_trace_summary, which is all a host without interactive views shows.",
    text: (found) => `${label(found.workspace)}\n${formatTrace(found.trace)}${found.note}`,
  },
  {
    view: "graph",
    tool: "render_graph",
    title: "Show trace service graph",
    description:
      "Show the service graph of one trace to the user as an interactive view, like the graph on Ivy's trace page: the " +
      "trigger, the function and every service it called as nodes with their icons, call counts and failures; clicking a " +
      "node shows the details of its spans. Use it when the user wants to see what a function talks to. The trace is " +
      "found in whichever of your workspaces holds it unless you pass workspace. You also get the graph as a text edge " +
      "list, which is all a host without interactive views shows.",
    text: (found) => `${label(found.workspace)}\n${formatServiceGraph(found.trace)}${found.note}`,
  },
];

function handler(data: IvyData, tool: ViewTool, withView: boolean) {
  return (args: { workspace?: string; trace_id: string }) =>
    guarded(async (): Promise<CallToolResult> => {
      const found = await findTrace(data, args.workspace, args.trace_id);
      const content: CallToolResult["content"] = [{ type: "text", text: tool.text(found) }];
      if (!withView) return { content };
      const { id, slug, name } = found.workspace;
      return { content, structuredContent: { workspace: { id, slug, name }, trace: viewTrace(found.trace) } };
    });
}

/**
 * `render_waterfall` and `render_graph`: MCP Apps tools whose result renders in the host as the
 * linked `ui://ivy/…` view, with a text fallback in `content` for hosts without MCP Apps. When a
 * view's HTML is missing (UI not built), the tool is registered as a plain text tool.
 */
export function registerViewTools(server: McpServer, data: IvyData, views: ViewHtml = {}) {
  const inputSchema = { workspace, trace_id: traceId };
  for (const tool of TOOLS) {
    const html = views[tool.view];
    const config = { title: tool.title, description: tool.description, inputSchema, annotations: { title: tool.title, ...READ_ONLY } };
    if (!html) {
      server.registerTool(tool.tool, config, handler(data, tool, false));
      continue;
    }
    const uri = VIEW_URIS[tool.view];
    registerAppResource(
      server,
      `Ivy ${tool.view} view`,
      uri,
      { description: `Interactive ${tool.view} of an Ivy trace`, mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            // No network access needed: data arrives with the tool result, icons and styles are inlined.
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
          },
        ],
      }),
    );
    registerAppTool(server, tool.tool, { ...config, _meta: { ui: { resourceUri: uri } } }, handler(data, tool, true));
  }
}
