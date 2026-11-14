import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Tooltipped } from "@/components/ui/tooltipped";
import { formatElapsed, inProgressState, isInProgressSpan, NO_COMPLETION_EXPLANATION, spanDeadlineMs } from "@/lib/spans/services";
import type { Span } from "@/lib/spans/types";
import { cn } from "@/lib/utils/cn";
import { formatTimestamp } from "@/lib/utils/format";

/** The current time, updated every `intervalMs` while `enabled`. */
export function useNow(enabled = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

export interface Progress {
  startMs: number;
  deadlineMs: number | null;
  lastSeenMs: number | null;
}

/** Start, deadline and last report of an in-progress invocation span; null for any other span. */
export function spanProgress(span: Span): Progress | null {
  if (!isInProgressSpan(span)) return null;
  const lastSeen = Number(span.attributes["ivy.last_seen_ms"]);
  return {
    startMs: Date.parse(span.start),
    deadlineMs: spanDeadlineMs(span),
    lastSeenMs: Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : Date.parse(span.end),
  };
}

const parse = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

export function rowProgress(row: { ts: string; deadline?: string | null; last_seen?: string | null }): Progress {
  return { startMs: Date.parse(row.ts), deadlineMs: parse(row.deadline), lastSeenMs: parse(row.last_seen) };
}

/** A small pulsing dot; static when the user prefers reduced motion. */
export function RunningDot({ className, color = "bg-sky-400" }: { className?: string; color?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      <span className={cn("absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping", color)} />
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}

function NoCompletion({ progress }: { progress: Progress }) {
  return (
    <Tooltipped
      title={
        <span className="block max-w-xs">
          {NO_COMPLETION_EXPLANATION}
          {progress.lastSeenMs !== null && <> Last seen running at {formatTimestamp(new Date(progress.lastSeenMs).toISOString())}.</>}
        </span>
      }
    >
      <span className="inline-flex items-center gap-2 whitespace-nowrap text-amber-400">
        <TriangleAlert className="size-4 shrink-0" />
        No completion recorded
      </span>
    </Tooltipped>
  );
}

/** "Running…" with a pulsing dot, or "No completion recorded" (amber) once the deadline has passed. */
export function InProgressStatus({ progress }: { progress: Progress }) {
  const now = useNow();
  if (inProgressState(progress.deadlineMs, now) === "no_completion") return <NoCompletion progress={progress} />;
  return (
    <Tooltipped title="Still running: Ivy reports long invocations while they run. The final record replaces this one.">
      <span className="inline-flex items-center gap-2 whitespace-nowrap text-sky-400">
        <RunningDot className="mx-1" />
        Running…
      </span>
    </Tooltipped>
  );
}

/** Time since the start, ticking while running; the last reported time once no completion was recorded. */
export function Elapsed({ progress, className }: { progress: Progress; className?: string }) {
  const now = useNow();
  const done = inProgressState(progress.deadlineMs, now) === "no_completion";
  const ms = (done ? (progress.lastSeenMs ?? now) : now) - progress.startMs;
  return <span className={cn("tabular-nums", className)}>{done ? `> ${formatElapsed(ms)}` : formatElapsed(ms)}</span>;
}

/** Explains an in-progress invocation on the trace page and in the MCP App view. */
export function InProgressNote({ invocation, className }: { invocation: Span; className?: string }) {
  const progress = spanProgress(invocation);
  const now = useNow(!!progress);
  if (!progress) return null;
  const done = inProgressState(progress.deadlineMs, now) === "no_completion";
  const deadline = progress.deadlineMs !== null ? formatTimestamp(new Date(progress.deadlineMs).toISOString()) : null;
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground",
        done ? "border-amber-400/30 bg-amber-400/5" : "border-sky-400/30 bg-sky-400/5",
        className,
      )}
    >
      {done ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" /> : <RunningDot className="mt-1" />}
      <span>
        {done
          ? NO_COMPLETION_EXPLANATION
          : `Still running. The spans of its calls arrive when it finishes; shown is what the Lambda extension reported so far${deadline ? ` (deadline ${deadline})` : ""}.`}
      </span>
    </p>
  );
}
