import { formatInvocations } from "@ivy/format";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IvyData } from "../data/types.js";
import { functionName, guarded, limit, READ_ONLY, since, text } from "./common.js";

const LIST_FORMAT =
  "Each line: time (UTC), status, function, duration, `cold` for cold starts, the HTTP route and status or the trigger, " +
  "the error for failures, and the trace ID to pass to get_trace_summary or compare_invocations.";

function heading(count: number, wanted: number, what: string, range: string) {
  const more = count >= wanted ? ` (showing the newest ${count}; narrow the range or raise limit for more)` : "";
  return `${count} ${what} in the last ${range}, newest first${more}:`;
}

export function registerInvocationTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "find_failing_invocations",
    {
      title: "Find failing invocations",
      description:
        "List the most recent failed Lambda invocations, newest first, one line each. Start here when asked what is " +
        "failing or why a function errors. Then call get_trace_summary with a trace ID for the full trace, or " +
        `compare_invocations to diff it against a successful run. ${LIST_FORMAT}`,
      inputSchema: { function: functionName, since: since("1h"), limit: limit(20) },
      annotations: { title: "Find failing invocations", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const items = await data.invocations({ function: args.function, status: "error", since: args.since, limit: args.limit });
        const what = `failed invocations${args.function ? ` of ${args.function}` : ""}`;
        if (!items.length) return text(`No ${what} in the last ${args.since}.`);
        return text(`${heading(items.length, args.limit, what, args.since)}\n${formatInvocations(items)}`);
      }),
  );

  server.registerTool(
    "search_invocations",
    {
      title: "Search invocations",
      description:
        "Search Lambda invocations, newest first, one line each. `q` matches a request ID or trace ID exactly, or a " +
        "substring of the error message or HTTP path (case-insensitive). Combine with function and status to narrow down, " +
        `e.g. recent successful runs of a function to compare with a failure. ${LIST_FORMAT}`,
      inputSchema: {
        q: z.string().min(1).optional().describe("Request ID, trace ID, or text in the error message or HTTP path."),
        function: functionName,
        status: z.enum(["ok", "error"]).optional().describe("Only successful (ok) or failed (error) invocations."),
        since: since("24h"),
        limit: limit(20),
      },
      annotations: { title: "Search invocations", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const items = await data.invocations({ q: args.q, function: args.function, status: args.status, since: args.since, limit: args.limit });
        if (!items.length) return text(`No matching invocations in the last ${args.since}.`);
        return text(`${heading(items.length, args.limit, "matching invocations", args.since)}\n${formatInvocations(items)}`);
      }),
  );
}
