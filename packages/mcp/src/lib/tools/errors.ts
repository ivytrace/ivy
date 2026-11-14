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
        "Distinct errors across your workspaces (or one), grouped by function, error type, code location and message " +
        "pattern, most frequent first. Use it for an overview of what is breaking and how often. Each line: " +
        "[workspace/project], count, function, the failure label for errors outside the handler (Init failed, Out of " +
        "memory, Timed out, Crashed), error type and message. When a group's messages differ only in variable parts, the " +
        "message is a template with placeholders ({id}, {num}, {path}, {email}, {url}, {ip}, {date}, {str}) followed by " +
        "the number of variants and the most frequent actual message. Then first and last seen (UTC), and a sample trace " +
        "ID to pass to get_trace_summary. Init failures have no trace spans: the sample trace holds only the platform " +
        "report and the log tail. Lambda throttles appear as one \"Throttled\" group per function with a count; throttled " +
        "requests never reach the function, so they have no trace.",
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
        const failed = groups.filter((g) => g.group.kind !== "throttle").reduce((n, g) => n + g.group.count, 0);
        const throttled = groups.filter((g) => g.group.kind === "throttle").reduce((n, g) => n + g.group.count, 0);
        const counts = `${failed} failed invocations${throttled ? `, ${throttled} throttled requests without a trace` : ""}`;
        const head = `${groups.length} error groups (${counts}) in ${where}, last ${args.since}${
          shown.length < groups.length ? `, top ${shown.length}` : ""
        }:`;
        const lines = shown.map((g) => `${label(g.workspace, g.group.project)} ${formatErrorGroups([g.group])}`);
        return text(`${head}\n${lines.join("\n")}${failureNote(result.failed)}`);
      }),
  );
}
