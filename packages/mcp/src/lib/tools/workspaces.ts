import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IvyData } from "../data/types.js";
import { guarded, READ_ONLY, text } from "./common.js";

export function registerWorkspaceTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "The workspaces you can read, one per line: slug, name and ID. Every other tool covers all of them unless you " +
        "pass `workspace` (slug or ID), and labels each result line with the workspace slug in brackets.",
      inputSchema: {},
      annotations: { title: "List workspaces", ...READ_ONLY },
    },
    () =>
      guarded(async () => {
        const workspaces = await data.workspaces();
        if (!workspaces.length) return text("You are not a member of any workspace.");
        const lines = workspaces.map((w) => `${w.slug} · ${w.name} · ${w.id}`);
        return text(`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
      }),
  );
}
