import { formatErrorGroups } from "@ivy/format";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IvyData } from "../data/types.js";
import { functionName, guarded, limit, READ_ONLY, since, text } from "./common.js";

export function registerErrorTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "list_error_groups",
    {
      title: "List error groups",
      description:
        "Distinct errors, grouped by function, error type and normalized message, most frequent first. Use it for an " +
        "overview of what is breaking and how often. Each line: count, function, error, first and last seen (UTC), and a " +
        "sample trace ID to pass to get_trace_summary.",
      inputSchema: { function: functionName, since: since("24h"), limit: limit(20) },
      annotations: { title: "List error groups", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const groups = await data.errors({ function: args.function, since: args.since });
        if (!groups.length) return text(`No errors${args.function ? ` in ${args.function}` : ""} in the last ${args.since}.`);
        const shown = groups.slice(0, args.limit);
        const total = groups.reduce((n, g) => n + g.count, 0);
        const head = `${groups.length} error groups (${total} failed invocations) in the last ${args.since}${
          shown.length < groups.length ? `, showing the top ${shown.length}` : ""
        }:`;
        return text(`${head}\n${formatErrorGroups(shown)}`);
      }),
  );
}
