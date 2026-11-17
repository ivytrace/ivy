import { formatQueryResult } from "@ivy/format";
import { QUERY_TABLES } from "@ivy/spans";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IvyData } from "../data/types.js";
import { selectWorkspaces, ToolInputError } from "../workspaces/scope.js";
import { guarded, limit, project, READ_ONLY, since, text, workspace } from "./common.js";

const tables = QUERY_TABLES.map(
  (t) => `${t.name}: ${t.description}\n${t.columns.map((c) => `  ${c.name} ${c.type}: ${c.description}`).join("\n")}`,
).join("\n");

export function registerQueryTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "run_query",
    {
      title: "Run a SQL query",
      description:
        "Runs one read-only ClickHouse SELECT over a workspace's invocations, spans and logs, and returns the rows as " +
        "text. Use it for questions the other tools can't answer: aggregations, top lists and percentiles across many " +
        "invocations, e.g. the slowest API routes, invocations with 30 or more database calls, error counts per hour. " +
        "The tables show only the chosen workspace, project and time range (`since`): don't filter on tenant or add " +
        "your own outer time bounds unless you want a narrower window. ClickHouse SQL: quantile(0.95)(x), countIf(cond), " +
        "uniq(x), toStartOfHour(ts), attributes['key'] for map columns; times are UTC. No FORMAT clause. Limits: 30 s per " +
        "query, rows capped at `limit`. Each row's trace_id can go to get_trace_summary.\n\nTables:\n" +
        tables,
      inputSchema: {
        sql: z.string().min(1).max(100_000).describe("One ClickHouse SELECT statement over the tables above."),
        workspace,
        project,
        since: since("24h"),
        limit: limit(100, 1000),
      },
      annotations: { title: "Run a SQL query", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const workspaces = await selectWorkspaces(data, args.workspace);
        if (workspaces.length > 1) {
          throw new ToolInputError(`A query runs in one workspace: pass \`workspace\` (one of ${workspaces.map((w) => w.slug).join(", ")}).`);
        }
        const [w] = workspaces;
        const result = await data.query(w, { sql: args.sql, project: args.project, since: args.since, limit: args.limit });
        const where = `[${w.slug}${args.project ? `/${args.project}` : ""}], last ${args.since}`;
        return text(`${where}: ${formatQueryResult(result)}`);
      }),
  );
}
