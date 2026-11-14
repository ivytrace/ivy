import { Info } from "lucide-react";

import { spanFailureKind } from "@/lib/spans/services";
import type { Span } from "@/lib/spans/types";
import { cn } from "@/lib/utils/cn";

/**
 * Explains why a failed invocation has no (or only partial) spans: the Ivy extension reported it from
 * the Lambda platform because the runtime never started the handler or the process died.
 */
export function FailureNote({ invocation, className }: { invocation: Span; className?: string }) {
  const kind = spanFailureKind(invocation);
  const synthetic = invocation.attributes["ivy.synthetic"] === "true";
  if (!kind || (kind !== "init_failed" && !synthetic)) return null;
  const text =
    kind === "init_failed"
      ? "The function failed while loading, so the handler never ran and there is no trace. Shown: the Lambda platform's report and the last log lines."
      : kind === "timed_out"
        ? "The handler never finished, so the tracer could not report. Shown: the Lambda platform's report and the last log lines."
        : "The process died before the tracer could report, so the trace is incomplete. Shown: the Lambda platform's report and the last log lines.";
  return (
    <p className={cn("flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-muted-foreground", className)}>
      <Info className="mt-0.5 size-3.5 shrink-0 text-red-400" />
      {text}
    </p>
  );
}
