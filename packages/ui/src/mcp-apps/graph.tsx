import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronRight, X } from "lucide-react";

import { ServiceIcon } from "@/components/common/service-icon";
import { SpanDetails } from "@/components/trace/span-details";
import { SpanTitle } from "@/components/trace/span-title";
import { TraceGraph } from "@/components/trace/trace-graph";
import type { GraphNode } from "@/lib/spans/graph";
import { describeSpan } from "@/lib/spans/services";
import type { Span } from "@/lib/spans/types";
import { cn } from "@/lib/utils/cn";
import { formatDuration } from "@/lib/utils/format";
import { ViewShell, type ViewData } from "./shell";
import "./view.css";

function SpanRow({ span, open, onToggle }: { span: Span; open: boolean; onToggle: () => void }) {
  const d = describeSpan(span);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn("flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40", open && "bg-muted/30")}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <ServiceIcon icon={d.icon} label={d.serviceLabel} />
        <span className={cn("min-w-0 flex-1 truncate", d.isError && "text-red-400")}>
          <SpanTitle description={d} />
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(span.duration_ms)}</span>
      </button>
      {open && (
        <div className="border-t bg-muted/10 px-4 py-4 md:px-8">
          <SpanDetails span={span} />
        </div>
      )}
    </div>
  );
}

/** The spans behind a clicked node, each expandable to its details (one span opens directly). */
function NodePanel({ node, spans, onClose }: { node: GraphNode; spans: Span[]; onClose: () => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(spans.length === 1 ? [spans[0].span_id] : []));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="border-t">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <ServiceIcon icon={node.icon} label={node.label} />
          <span className="truncate font-medium">{node.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {node.isTrigger ? "trigger" : `${spans.length} span${spans.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="max-h-[420px] divide-y overflow-auto border-t">
        {spans.map((span) => (
          <SpanRow key={span.span_id} span={span} open={open.has(span.span_id)} onToggle={() => toggle(span.span_id)} />
        ))}
      </div>
    </div>
  );
}

function ServiceGraph({ data, fullscreen }: { data: ViewData; fullscreen: boolean }) {
  const spans = data.trace.spans;
  const byId = useMemo(() => new Map(spans.map((s) => [s.span_id, s])), [spans]);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const selectedSpans = selected ? selected.spanIds.map((id) => byId.get(id)).filter((s): s is Span => !!s) : [];

  return (
    <>
      <div className={cn("relative", fullscreen ? "min-h-[480px] flex-1" : "h-[380px]")}>
        <TraceGraph spans={spans} onSelect={setSelected} />
        {!selected && (
          <div className="pointer-events-none absolute bottom-2 left-0 right-0 text-center text-xs text-muted-foreground">
            Click a service for its spans
          </div>
        )}
      </div>
      {selected && <NodePanel key={selected.id} node={selected} spans={selectedSpans} onClose={() => setSelected(null)} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewShell name="Ivy service graph">{(data, { fullscreen }) => <ServiceGraph data={data} fullscreen={fullscreen} />}</ViewShell>
  </StrictMode>,
);
