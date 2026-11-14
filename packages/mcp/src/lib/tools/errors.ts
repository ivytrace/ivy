import { formatErrorGroups } from "@ivy/format";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IvyData } from "../data/types.js";
import { failureNote, fanOut } from "../workspaces/fan-out.js";
import { selectWorkspaces, scoped } from "../workspaces/scope.js";
import { failure, functionName, guarded, label, limit, READ_ONLY, since, text, project, workspace } from "./common.js";

export function registerErrorTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "list_error_groups",
    {
      title: "List error groups",
      description:
        "Distinct errors across your workspaces (or one), grouped by function, error type and normalized message, most " +
        "frequent first. Use it for an overview of what is breaking and how often. Each line: [workspace], count, " +
        "function, error, first and last seen (UTC), and a sample trace ID to pass to get_trace_summary.",
      inputSchema: { workspace, project, function: functionName, since: since("24h"), limit: limit(20) },
      annotations: { title: "List error groups", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const workspaces = await selectWorkspaces(data, args.workspace);
        const result = await fanOut(workspaces, (w) => scoped(data, args).errors(w, { function: args.function, since: args.since }));
        if (!result.ok.length) return failure(`Could not read any workspace.${failureNote(result.failed)}`);

        const groups = result.ok.flatMap((r) => r.value.map((group) => ({ workspace: r.workspace, group })));
        groups.sort((a, b) => b.group.count - a.group.count || b.group.last_seen.localeCompare(a.group.last_seen));
        const where = workspaces.length === 1 ? `workspace ${workspaces[0].slug}` : `${workspaces.length} workspaces`;
        if (!groups.length) {
          return text(`No errors${args.function ? ` in ${args.function}` : ""} in ${where} in the last ${args.since}.${failureNote(result.failed)}`);
        }
        const shown = groups.slice(0, args.limit);
        const total = groups.reduce((n, g) => n + g.group.count, 0);
        const head = `${groups.length} error groups (${total} failed invocations) in ${where}, last ${args.since}${
          shown.length < groups.length ? `, top ${shown.length}` : ""
        }:`;
        const lines = shown.map((g) => `${label(g.workspace)} ${formatErrorGroups([g.group])}`);
        return text(`${head}\n${lines.join("\n")}${failureNote(result.failed)}`);
      }),
  );
}
