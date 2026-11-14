import { Info } from "lucide-react";

import { collapsedCalls, droppedSpans, droppedSpansLabel, formatCount } from "@/lib/spans/services";
import type { Span } from "@/lib/spans/types";
import { cn } from "@/lib/utils/cn";

/** Says that the tracer omitted spans of this invocation (`ivy.dropped_spans`), so the timeline is incomplete. */
export function OmittedSpansNote({ invocation, className }: { invocation: Span; className?: string }) {
  const dropped = droppedSpans(invocation.attributes);
  if (!dropped) return null;
  const collapsed = collapsedCalls(invocation.attributes);
  return (
    <p className={cn("flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-muted-foreground", className)}>
      <Info className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
      <span>
        <span className="font-medium text-foreground">{droppedSpansLabel(dropped)}</span>: this invocation made more calls
        than Ivy keeps, so the timeline is incomplete.
        {collapsed ? ` ${formatCount(collapsed)} similar calls are summarised in the × rows.` : ""}
      </span>
    </p>
  );
}
