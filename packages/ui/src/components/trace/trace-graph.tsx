import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import Dagre from "@dagrejs/dagre";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import { buildServiceGraph, type GraphNode } from "@/lib/spans/graph";
import type { Span } from "@/lib/spans/types";
import { cn } from "@/lib/utils/cn";

type FlowNode = Node<GraphNode & Record<string, unknown>, "service">;

const NODE_SIZE = 40;

function ServiceNode({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className={cn(
        "relative size-10 cursor-pointer rounded-full bg-zinc-500 bg-cover bg-center ring-offset-2 ring-offset-background",
        data.isError && "ring-2 ring-red-400",
      )}
      style={{ backgroundImage: `url(/images/service-icons/${data.icon}.svg)` }}
      title={data.label}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {data.instances > 1 && (
        <div className="absolute -right-2 -top-2 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] leading-5 text-white">
          {data.instances}
        </div>
      )}
      <div className="pointer-events-none absolute -left-12 -right-12 top-full mt-2 truncate text-center text-xs text-foreground">
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = { service: ServiceNode };

function layout(spans: Span[]): { nodes: FlowNode[]; edges: Edge[] } {
  const graph = buildServiceGraph(spans);
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", ranksep: 80, nodesep: 60 });
  graph.nodes.forEach((n) => g.setNode(n.id, { width: NODE_SIZE + 60, height: NODE_SIZE + 30 }));
  graph.edges.forEach((e) => g.setEdge(e.source, e.target));
  Dagre.layout(g);

  return {
    nodes: graph.nodes.map((n) => {
      const pos = g.node(n.id);
      return {
        id: n.id,
        type: "service",
        position: { x: pos.x - NODE_SIZE / 2, y: pos.y - NODE_SIZE / 2 },
        data: n,
        draggable: false,
        connectable: false,
        deletable: false,
      };
    }),
    edges: graph.edges.map((e) => ({ ...e, selectable: false, deletable: false })),
  };
}

export function TraceGraph({ spans, onSelect }: { spans: Span[]; onSelect: (node: GraphNode) => void }) {
  const { nodes, edges } = useMemo(() => layout(spans), [spans]);
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.data)}
        fitView
        fitViewOptions={{ padding: 0.4, minZoom: 0.5, maxZoom: 1.25 }}
        nodesDraggable={false}
        nodesConnectable={false}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
