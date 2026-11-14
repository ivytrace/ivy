import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IvyData } from "../data/types.js";
import { registerErrorTools } from "../tools/errors.js";
import { registerInvocationTools } from "../tools/invocations.js";
import { registerTraceTools } from "../tools/traces.js";

const INSTRUCTIONS =
  "Ivy traces AWS Lambda functions: every invocation with its AWS SDK and HTTP calls, payloads, logs and errors. " +
  "To debug a failure: list_error_groups or find_failing_invocations to find it, get_trace_summary to read the trace, " +
  "compare_invocations to diff it against a successful run. All times are UTC; all tools are read-only.";

/** A new MCP server with Ivy's tools, reading through `data`. Stateless: build one per request. */
export function createIvyMcpServer(data: IvyData, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "ivy", title: "Ivy", version }, { instructions: INSTRUCTIONS });
  registerInvocationTools(server, data);
  registerTraceTools(server, data);
  registerErrorTools(server, data);
  return server;
}
