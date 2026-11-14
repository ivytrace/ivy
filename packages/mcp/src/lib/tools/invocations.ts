import { formatInvocationLine } from "@ivy/format";
import type { Invocation } from "@ivy/spans";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InvocationQuery, IvyData, Workspace } from "../data/types.js";
import { failureNote, fanOut } from "../workspaces/fan-out.js";
import { selectWorkspaces, scoped } from "../workspaces/scope.js";
import { failure, functionName, guarded, label, limit, READ_ONLY, since, text, project, workspace } from "./common.js";

const LIST_FORMAT =
  "Each line: [workspace], time (UTC), status, function, duration, `cold` for cold starts, the HTTP route and status " +
  "or the trigger, the error for failures, and the trace ID to pass to get_trace_summary or compare_invocations.";

/** Runs the query in every selected workspace, merges newest first and cuts to the combined limit. */
async function listAcross(data: IvyData, scope: string | undefined, query: InvocationQuery & { limit: number; since: string }, what: string) {
  const workspaces = await selectWorkspaces(data, scope);
  const result = await fanOut(workspaces, (w) => data.invocations(w, query));
  if (!result.ok.length) return failure(`Could not read any workspace.${failureNote(result.failed)}`);

  const rows: { workspace: Workspace; inv: Invocation }[] = result.ok.flatMap((r) => r.value.map((inv) => ({ workspace: r.workspace, inv })));
  rows.sort((a, b) => b.inv.ts.localeCompare(a.inv.ts));
  const shown = rows.slice(0, query.limit);
  const where = workspaces.length === 1 ? `workspace ${workspaces[0].slug}` : `${workspaces.length} workspaces`;
  if (!shown.length) return text(`No ${what} in ${where} in the last ${query.since}.${failureNote(result.failed)}`);

  const more = rows.length > shown.length || result.ok.some((r) => r.value.length >= query.limit) ? "; more exist, narrow the range or raise limit" : "";
  const head = `${shown.length} ${what} in ${where}, last ${query.since}, newest first${more}:`;
  const lines = shown.map((r) => `${label(r.workspace)} ${formatInvocationLine(r.inv)}`);
  return text(`${head}\n${lines.join("\n")}${failureNote(result.failed)}`);
}

export function registerInvocationTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "find_failing_invocations",
    {
      title: "Find failing invocations",
      description:
        "List the most recent failed Lambda invocations across your workspaces (or one), newest first, one line each. " +
        "Start here when asked what is failing or why a function errors. Then call get_trace_summary with a trace ID for " +
        `the full trace, or compare_invocations to diff it against a successful run. ${LIST_FORMAT}`,
      inputSchema: { workspace, project, function: functionName, since: since("1h"), limit: limit(20) },
      annotations: { title: "Find failing invocations", ...READ_ONLY },
    },
    (args) =>
      guarded(() =>
        listAcross(
          scoped(data, args),
          args.workspace,
          { function: args.function, status: "error", since: args.since, limit: args.limit },
          `failed invocations${args.function ? ` of ${args.function}` : ""}`,
        ),
      ),
  );

  server.registerTool(
    "search_invocations",
    {
      title: "Search invocations",
      description:
        "Search Lambda invocations across your workspaces (or one), newest first, one line each. `q` matches a request " +
        "ID or trace ID exactly, or a substring of the error message or HTTP path (case-insensitive). Combine with " +
        `function and status to narrow down, e.g. recent successful runs of a function to compare with a failure. ${LIST_FORMAT}`,
      inputSchema: {
        workspace,
        project,
        q: z.string().min(1).optional().describe("Request ID, trace ID, or text in the error message or HTTP path."),
        function: functionName,
        status: z.enum(["ok", "error"]).optional().describe("Only successful (ok) or failed (error) invocations."),
        since: since("24h"),
        limit: limit(20),
      },
      annotations: { title: "Search invocations", ...READ_ONLY },
    },
    (args) =>
      guarded(() =>
        listAcross(
          scoped(data, args),
          args.workspace,
          { q: args.q, function: args.function, status: args.status, since: args.since, limit: args.limit },
          "matching invocations",
        ),
      ),
  );
}
