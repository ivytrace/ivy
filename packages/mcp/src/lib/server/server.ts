import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerViewTools, type ViewHtml } from "../apps/views.js";
import type { IvyData } from "../data/types.js";
import { registerErrorTools } from "../tools/errors.js";
import { registerInvocationTools } from "../tools/invocations.js";
import { registerQueryTools } from "../tools/query.js";
import { registerTraceTools } from "../tools/traces.js";
import { registerWorkspaceTools } from "../tools/workspaces.js";

const INSTRUCTIONS =
  "Ivy traces AWS Lambda functions: every invocation with its AWS SDK and HTTP calls, payloads, logs and errors. " +
  "To debug a failure: list_error_groups or find_failing_invocations to find it, get_trace_summary to read the trace, " +
  "compare_invocations to diff it against a successful run. To show a trace to the user, render_waterfall (timeline) " +
  "or render_graph (service graph). Tools cover all of your workspaces unless you pass `workspace` (list_workspaces " +
  "shows them) and label results with the workspace in brackets. All times are UTC; all tools are read-only.";

export interface IvyMcpServerOptions {
  version?: string;
  /** HTML of the MCP Apps views; without it render_waterfall and render_graph answer in text only. */
  views?: ViewHtml;
}

/** A new MCP server with Ivy's tools, reading through `data`. Stateless: build one per request. */
export function createIvyMcpServer(data: IvyData, options: IvyMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "ivy", title: "Ivy", version: options.version ?? "0.1.0" }, { instructions: INSTRUCTIONS });
  registerWorkspaceTools(server, data);
  registerInvocationTools(server, data);
  registerTraceTools(server, data);
  registerErrorTools(server, data);
  registerQueryTools(server, data);
  registerViewTools(server, data, options.views);
  return server;
}
