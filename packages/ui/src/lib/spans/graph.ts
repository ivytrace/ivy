import { describeSpan, isInvocationSpan, triggerIcon, triggerLabel, type ServiceIcon } from "./services";
import type { Span } from "./types";

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

export function buildServiceGraph(spans: Span[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const nodeOfSpan = new Map<string, string>();

  for (const span of spans) {
    const d = describeSpan(span);
    const id = d.isInvocation ? `fn:${span.name}` : d.groupingKey;
    const node = nodes.get(id);
    if (node) {
      node.spanIds.push(span.span_id);
      node.instances += 1;
      node.isError ||= d.isError;
    } else {
      nodes.set(id, {
        id,
        label: d.graphLabel,
        icon: d.isInvocation ? "lambda" : d.icon,
        spanIds: [span.span_id],
        instances: 1,
        isTrigger: false,
        isError: d.isError,
      });
    }
    nodeOfSpan.set(span.span_id, id);
  }

  const addEdge = (source: string, target: string) => {
    if (source === target) return;
    const id = `${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target });
  };

  for (const span of spans) {
    const target = nodeOfSpan.get(span.span_id)!;
    const parent = span.parent_span_id ? nodeOfSpan.get(span.parent_span_id) : undefined;
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
