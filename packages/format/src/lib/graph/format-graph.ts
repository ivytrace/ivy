import { buildServiceGraph, collapsedInfo, describeSpan, type GraphNode, type Trace } from "@ivy/spans";
import { ms } from "../text/text.js";
import { rootInvocation } from "../trace/tree.js";

const KIND: Record<string, string> = {
  ai: "LLM",
  apigw: "API Gateway",
  lambda: "Lambda",
  function: "function",
  dynamodb: "DynamoDB",
  s3: "S3",
  sqs: "SQS",
  sns: "SNS",
  eventBridge: "EventBridge",
  ses: "SES",
  secretsmanager: "Secrets Manager",
  cloudwatch: "CloudWatch",
  cloudfront: "CloudFront",
  external: "HTTP",
  aws: "AWS",
};

/**
 * The trace's service graph (the dashboard's graph: one node per function, trigger and called
 * service) as a compact edge list, e.g. `checkout-createOrder → checkout-users [DynamoDB, 2 calls, 21.4ms] ERROR`.
 */
export function formatServiceGraph(trace: Trace): string {
  const { nodes, edges } = buildServiceGraph(trace.spans);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const spans = new Map(trace.spans.map((s) => [s.span_id, s]));
  /** Time in the node; spans nested in another span of the same node (an LLM operation's model calls) count once. */
  const total = (n: GraphNode) => {
    const ids = new Set(n.spanIds);
    return n.spanIds.reduce((sum, id) => {
      const span = spans.get(id);
      if (!span || ids.has(span.parent_span_id)) return sum;
      return sum + (collapsedInfo(span)?.totalMs ?? span.duration_ms);
    }, 0);
  };

  const describe = (n: GraphNode) => {
    if (n.isTrigger) return `${n.label} [trigger]`;
    const first = spans.get(n.spanIds[0]);
    const d = first && describeSpan(first);
    const kind = `${KIND[n.icon] ?? n.icon}${d && !d.isInvocation ? ` ${d.operation}` : ""}`;
    const calls = n.instances > 1 ? `, ${n.instances} calls` : "";
    return `${n.label} [${kind}${calls}, ${ms(total(n))}]${n.isError ? " ERROR" : ""}`;
  };

  const root = rootInvocation(trace.spans);
  const head = `Service graph of ${root?.name ?? trace.spans[0]?.name ?? "trace"} (trace ${trace.trace_id}): ${nodes.length} nodes, ${edges.length} edges`;
  const lines = edges.map((e) => `${byId.get(e.source)!.label} → ${describe(byId.get(e.target)!)}`);
  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const alone = nodes.filter((n) => !linked.has(n.id)).map((n) => `${describe(n)} (no edges)`);
  const failed = trace.spans.filter((s) => s.status_code === "ERROR").map((s) => describeSpan(s).graphLabel);
  const tail = failed.length ? [`Failed: ${[...new Set(failed)].join(", ")}`] : [];
  return [head, ...lines, ...alone, ...tail].join("\n");
}
