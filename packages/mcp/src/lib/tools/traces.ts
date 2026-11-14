import { compareTraces, formatTrace, rootInvocation } from "@ivy/format";
import type { Trace } from "@ivy/spans";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IvyData, Workspace } from "../data/types.js";
import { failureNote, findFirst } from "../workspaces/fan-out.js";
import { locateTrace, selectWorkspaces, ToolInputError, scoped } from "../workspaces/scope.js";
import { failure, guarded, label, maxTokens, READ_ONLY, text, traceId, project, workspace } from "./common.js";

/** Request IDs and baselines are looked up over this range; traces by ID need no range. */
const LOOKBACK = "7d";

export interface FoundTrace {
  workspace: Workspace;
  trace: Trace;
  /** Workspaces that could not be searched, as a note to append (empty when all answered). */
  note: string;
}

/** Loads a trace from the named workspace, or from whichever of the caller's workspaces holds it. */
export async function findTrace(data: IvyData, scope: string | undefined, id: string): Promise<FoundTrace> {
  const workspaces = await selectWorkspaces(data, scope);
  const { hit, failed } = await locateTrace(data, workspaces, id);
  if (!hit) {
    const where = workspaces.length === 1 ? `workspace ${workspaces[0].slug}` : `any of your ${workspaces.length} workspaces`;
    throw new ToolInputError(`Trace ${id} not found in ${where}. Check the ID, or use search_invocations to find it.${failureNote(failed)}`);
  }
  return { ...hit, note: failureNote(failed) };
}

async function traceIdForRequest(data: IvyData, scope: string | undefined, requestId: string): Promise<{ id: string; workspace: Workspace }> {
  const workspaces = await selectWorkspaces(data, scope);
  const { hit, failed } = await findFirst(workspaces, async (w) => {
    const [match] = await data.invocations(w, { q: requestId, since: LOOKBACK, limit: 1 });
    return match?.request_id === requestId ? match.trace_id : null;
  });
  if (!hit) throw new ToolInputError(`No invocation with request ID ${requestId} in the last ${LOOKBACK}.${failureNote(failed)}`);
  return { id: hit.value, workspace: hit.workspace };
}

export function registerTraceTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "get_trace_summary",
    {
      title: "Get trace summary",
      description:
        "The full trace of one invocation as a compact text tree. Pass trace_id, or request_id (the AWS request ID) to look " +
        "it up; the trace is found in whichever of your workspaces holds it unless you pass workspace. First line: the " +
        "[workspace]. Header: function, trigger, cold start, duration, status, IDs. Then one line per span: offset from the " +
        "start and duration in ms, indentation for nesting, a description of the call (e.g. `DynamoDB.GetItem orders (1 item " +
        "returned)`, `POST api.stripe.com/v1/charges → 402`) and status. Errors (`!`) come with type, message and the top " +
        "stack frames; logs appear at their time; `req:`/`res:` lines are trimmed payloads (secrets were redacted at the " +
        "source). Repeated identical calls are folded into one `×N` line. When the tracer itself summarised a run of " +
        "similar calls, the summary span reads e.g. `DynamoDB.PutItem orders × 1,184 (first→last …, total …, avg …, min …, " +
        "max …, 1 error, 9 kept)`: N calls in the summary, while the failing ones and `kept` others are separate lines. " +
        "A header line like `37 spans omitted (span limit)` means the trace is incomplete.",
      inputSchema: {
        workspace,
        project,
        trace_id: traceId.optional(),
        request_id: z.string().min(1).optional().describe("AWS request ID of the invocation; used when trace_id is not given."),
        detail: z
          .enum(["summary", "normal", "full"])
          .default("normal")
          .describe(
            "summary: spans, errors, warn/error logs. normal (default): plus all logs and the payloads of the invocation and " +
              "of failed calls. full: payloads and headers of every call, no folding.",
          ),
        max_tokens: maxTokens,
      },
      annotations: { title: "Get trace summary", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        let id = args.trace_id;
        let scope = args.workspace;
        if (!id && args.request_id) {
          const found = await traceIdForRequest(scoped(data, args), scope, args.request_id);
          id = found.id;
          scope = found.workspace.id;
        }
        if (!id) return failure("Pass trace_id or request_id.");
        const found = await findTrace(scoped(data, args), scope, id);
        return text(`${label(found.workspace)}\n${formatTrace(found.trace, { detail: args.detail, maxTokens: args.max_tokens })}${found.note}`);
      }),
  );

  server.registerTool(
    "compare_invocations",
    {
      title: "Compare invocations",
      description:
        "Diff two invocations, typically a failing one and a successful one of the same function, to see what changed. " +
        "Without baseline_trace_id, the most recent successful invocation of the same function in the same workspace " +
        "(last 7 days) is used. Shows top-level differences (status, HTTP status, duration, cold start, the error), then the " +
        "calls of both traces aligned: `=` same call, `~` same call with a different outcome, timing or payload shape " +
        "(differing payload fields listed below it), `+`/`-` calls made by only one side.",
      inputSchema: {
        workspace,
        project,
        trace_id: traceId.describe("The invocation to explain, usually the failing one."),
        baseline_trace_id: traceId.optional().describe("The invocation to compare against. Default: the latest successful run of the same function."),
        max_tokens: maxTokens,
      },
      annotations: { title: "Compare invocations", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const target = await findTrace(scoped(data, args), args.workspace, args.trace_id);
        let baseline: FoundTrace;
        let preface = "";
        if (args.baseline_trace_id) {
          baseline = await findTrace(scoped(data, args), args.workspace, args.baseline_trace_id);
        } else {
          const fn = rootInvocation(target.trace.spans)?.name;
          if (!fn) return failure("The trace has no Ivy invocation span, so there is no function to pick a baseline from. Pass baseline_trace_id.");
          const [ok] = await scoped(data, args).invocations(target.workspace, { function: fn, status: "ok", since: LOOKBACK, limit: 1 });
          if (!ok) return failure(`No successful invocation of ${fn} in ${target.workspace.slug} in the last ${LOOKBACK}. Pass baseline_trace_id.`);
          baseline = await findTrace(scoped(data, args), target.workspace.id, ok.trace_id);
          preface = `B is the latest successful invocation of ${fn}.\n`;
        }
        const where =
          target.workspace.id === baseline.workspace.id
            ? label(target.workspace)
            : `A ${label(target.workspace)}, B ${label(baseline.workspace)}`;
        return text(`${where}\n${preface}${compareTraces(target.trace, baseline.trace, { maxTokens: args.max_tokens })}${target.note}`);
      }),
  );
}
