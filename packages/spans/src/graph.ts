import { describeSpan, isInvocationSpan, triggerIcon, triggerLabel, type ServiceIcon } from "./services.js";
import type { Span } from "./types.js";

export type GraphNode = {
  id: string;
  label: string;
  icon: ServiceIcon;
  spanIds: string[];
  instances: number;
  isTrigger: boolean;
  isError: boolean;
};

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * One node per function, trigger and called service. LLM spans become one node per provider, counting
 * model calls; agent steps and tool executions are not nodes (what a tool calls hangs off the function),
 * and spans inside a model call (the provider's HTTP request) belong to the provider's node.
 */
export function buildServiceGraph(spans: Span[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const nodeOfSpan = new Map<string, string>();
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const llmNodes = new Map<string, { calls: number; operations: number }>();

  for (const span of spans) {
    const d = describeSpan(span);
    const llm = d.llm;
    if (llm && (llm.kind === "tool" || llm.kind === "step")) continue;
    const parent = byId.get(span.parent_span_id);
    const parentLlm = parent && describeSpan(parent).llm;
    const insideCall = !llm && !!parentLlm && (parentLlm.kind === "call" || parentLlm.kind === "embedding");
    const id = d.isInvocation ? `fn:${span.name}` : insideCall ? describeSpan(parent!).groupingKey : d.groupingKey;
    if (llm || insideCall) {
      const counts = llmNodes.get(id) ?? { calls: 0, operations: 0 };
      if (llm?.kind === "operation") counts.operations++;
      else if (llm) counts.calls++;
      llmNodes.set(id, counts);
    }
    const node = nodes.get(id);
    if (node) {
      node.spanIds.push(span.span_id);
      node.instances += d.collapsed?.count ?? 1;
      node.isError ||= d.isError;
    } else {
      nodes.set(id, {
        id,
        label: d.graphLabel,
        icon: d.isInvocation ? "lambda" : d.icon,
        spanIds: [span.span_id],
        instances: d.collapsed?.count ?? 1,
        isTrigger: false,
        isError: d.isError,
      });
    }
    nodeOfSpan.set(span.span_id, id);
  }
  for (const [id, counts] of llmNodes) {
    const node = nodes.get(id);
    if (node) node.instances = counts.calls || counts.operations || 1;
  }

  /** Nearest ancestor node that isn't an LLM node, skipping spans without one (agent steps, tools). */
  const sourceOf = (span: Span): string | undefined => {
    let parent = byId.get(span.parent_span_id);
    while (parent) {
      const id = nodeOfSpan.get(parent.span_id);
      if (id && !llmNodes.has(id)) return id;
      parent = byId.get(parent.parent_span_id);
    }
    return undefined;
  };

  const addEdge = (source: string, target: string) => {
    if (source === target) return;
    const id = `${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target });
  };

  for (const span of spans) {
    const target = nodeOfSpan.get(span.span_id);
    if (!target) continue;
    const parent = sourceOf(span);
    if (parent) {
      addEdge(parent, target);
    } else if (isInvocationSpan(span)) {
      const source = span.attributes["ivy.trigger.source"] || "unknown";
      const triggerId = `trigger:${source}`;
      if (!nodes.has(triggerId)) {
        nodes.set(triggerId, {
          id: triggerId,
          label: triggerLabel(source),
          icon: triggerIcon(source),
          spanIds: [span.span_id],
          instances: 1,
          isTrigger: true,
          isError: false,
        });
      }
      addEdge(triggerId, target);
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
