import { compareTraces, formatTrace, rootInvocation } from "@ivy/format";
import type { Trace } from "@ivy/spans";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IvyData } from "../data/types.js";
import { failure, guarded, maxTokens, READ_ONLY, text, traceId } from "./common.js";

/** Request IDs are looked up over this range; traces by ID need no range. */
const REQUEST_ID_RANGE = "7d";

async function loadTrace(data: IvyData, id: string): Promise<Trace | string> {
  const trace = await data.trace(id.toLowerCase());
  return trace ?? `Trace ${id} not found. Check the ID, or use search_invocations to find it.`;
}

export function registerTraceTools(server: McpServer, data: IvyData) {
  server.registerTool(
    "get_trace_summary",
    {
      title: "Get trace summary",
      description:
        "The full trace of one invocation as a compact text tree. Pass trace_id, or request_id (the AWS request ID) to look " +
        "it up. Header: function, trigger, cold start, duration, status, IDs. Then one line per span: offset from the start " +
        "and duration in ms, indentation for nesting, a description of the call (e.g. `DynamoDB.GetItem orders (1 item " +
        "returned)`, `POST api.stripe.com/v1/charges → 402`) and status. Errors (`!`) come with type, message and the top " +
        "stack frames; logs appear at their time; `req:`/`res:` lines are trimmed payloads (secrets were redacted at the " +
        "source). Repeated identical calls are folded into one `×N` line.",
      inputSchema: {
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
        if (!id && args.request_id) {
          const [match] = await data.invocations({ q: args.request_id, since: REQUEST_ID_RANGE, limit: 1 });
          if (!match || match.request_id !== args.request_id) {
            return failure(`No invocation with request ID ${args.request_id} in the last ${REQUEST_ID_RANGE}.`);
          }
          id = match.trace_id;
        }
        if (!id) return failure("Pass trace_id or request_id.");
        const trace = await loadTrace(data, id);
        if (typeof trace === "string") return failure(trace);
        return text(formatTrace(trace, { detail: args.detail, maxTokens: args.max_tokens }));
      }),
  );

  server.registerTool(
    "compare_invocations",
    {
      title: "Compare invocations",
      description:
        "Diff two invocations, typically a failing one and a successful one of the same function, to see what changed. " +
        "Without baseline_trace_id, the most recent successful invocation of the same function (last 7 days) is used. " +
        "Shows top-level differences (status, HTTP status, duration, cold start, the error), then the calls of both traces " +
        "aligned: `=` same call, `~` same call with a different outcome, timing or payload shape (differing payload fields " +
        "listed below it), `+`/`-` calls made by only one side.",
      inputSchema: {
        trace_id: traceId.describe("The invocation to explain, usually the failing one."),
        baseline_trace_id: traceId.optional().describe("The invocation to compare against. Default: the latest successful run of the same function."),
        max_tokens: maxTokens,
      },
      annotations: { title: "Compare invocations", ...READ_ONLY },
    },
    (args) =>
      guarded(async () => {
        const target = await loadTrace(data, args.trace_id);
        if (typeof target === "string") return failure(target);

        let baselineId = args.baseline_trace_id;
        let preface = "";
        if (!baselineId) {
          const fn = rootInvocation(target.spans)?.name;
          if (!fn) return failure("The trace has no Ivy invocation span, so there is no function to pick a baseline from. Pass baseline_trace_id.");
          const [ok] = await data.invocations({ function: fn, status: "ok", since: "7d", limit: 1 });
          if (!ok) return failure(`No successful invocation of ${fn} in the last 7 days to compare with. Pass baseline_trace_id.`);
          baselineId = ok.trace_id;
          preface = `B is the latest successful invocation of ${fn}.\n`;
        }
        const baseline = await loadTrace(data, baselineId);
        if (typeof baseline === "string") return failure(baseline);
        return text(preface + compareTraces(target, baseline, { maxTokens: args.max_tokens }));
      }),
  );
}
