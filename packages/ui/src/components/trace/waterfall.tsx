import type { CSSProperties, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Elapsed, spanProgress, useNow } from "@/components/common/in-progress";
import { ServiceIcon } from "@/components/common/service-icon";
import { SpanDetails } from "@/components/trace/span-details";
import { CollapsedBadge, SpanTitle } from "@/components/trace/span-title";
import { describeSpan, inProgressState, type ServiceIcon as Icon } from "@/lib/spans/services";
import type { WaterfallRow } from "@/lib/spans/tree";
import { TINT_CLASSES } from "@/lib/spans/tint";
import { cn } from "@/lib/utils/cn";
import { formatDuration } from "@/lib/utils/format";

const BAR_COLORS: Partial<Record<Icon, string>> = {
  ai: "bg-violet-400",
  function: "bg-orange-400",
  lambda: "bg-orange-400",
  dynamodb: "bg-fuchsia-400",
  s3: "bg-green-400",
  sqs: "bg-pink-400",
  sns: "bg-pink-400",
  eventBridge: "bg-pink-400",
  ses: "bg-rose-400",
  secretsmanager: "bg-red-300",
  external: "bg-sky-400",
};

const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Summary spans cover a run of calls from the first start to the last end: hatched, so they don't read as one long call. */
const COLLAPSED_BAR = {
  backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, hsl(var(--background) / 0.6) 3px 6px)",
};

export function Waterfall({
  rows,
  totalMs,
  openIds,
  onToggle,
  details = (span) => <SpanDetails span={span} />,
}: {
  rows: WaterfallRow[];
  totalMs: number;
  openIds: Set<string>;
  onToggle: (spanId: string) => void;
  /** Content of an expanded row; the span's details by default. */
  details?: (span: WaterfallRow["span"]) => ReactNode;
}) {
  const running = rows.some((r) => spanProgress(r.span));
  const now = useNow(running, 5000);
  return (
    <div className="rounded-md border text-sm">
      <div className="flex border-b text-xs text-muted-foreground">
        <div className="w-[40%] shrink-0 px-3 py-2 sm:w-[48%] sm:px-4">Span</div>
        <div className="relative flex-1 py-2 pr-14 sm:pr-20">
          <div className="relative h-4">
            {TICKS.map((t) => (
              <span
                key={t}
                className={cn(
                  "absolute whitespace-nowrap",
                  t === 1 ? "-translate-x-full" : t > 0 && "-translate-x-1/2",
                  (t === 0.25 || t === 0.75) && "hidden sm:inline",
                )}
                style={{ left: `${t * 100}%` }}
              >
                {formatDuration(totalMs * t)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="divide-y">
        {rows.map((row) => {
          const d = describeSpan(row.span);
          const open = openIds.has(row.span.span_id);
          const progress = spanProgress(row.span);
          const stalled = progress && inProgressState(progress.deadlineMs, now) === "no_completion";
          const color = d.isError
            ? "bg-red-400"
            : stalled
              ? "bg-amber-400"
              : progress
                ? "bg-sky-400"
                : ((d.tint && TINT_CLASSES[d.tint].bar) ?? BAR_COLORS[d.icon] ?? "bg-zinc-400");
          return (
            <div key={row.span.span_id} id={`span-${row.span.span_id}`} className="transition-colors">
              <button
                type="button"
                onClick={() => onToggle(row.span.span_id)}
                aria-expanded={open}
                className={cn("flex w-full items-center text-left hover:bg-muted/40", open && "bg-muted/30")}
              >
                <div
                  className="flex w-[40%] shrink-0 items-center gap-1.5 py-2 pl-[calc(6px+var(--depth)*8px)] pr-2 sm:w-[48%] sm:gap-2 sm:pl-[calc(12px+var(--depth)*16px)] sm:pr-3"
                  style={{ "--depth": row.depth } as CSSProperties}
                >
                  <ChevronRight
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                  />
                  <ServiceIcon icon={d.icon} tint={d.tint} label={d.serviceLabel} />
                  <span className={cn("min-w-0 flex-1 truncate", d.isError && "text-red-400")}>
                    <SpanTitle description={d} stackNote badge={false} />
                  </span>
                  {d.collapsed && <CollapsedBadge collapsed={d.collapsed} className="ml-0 shrink-0" />}
                </div>
                <div className="relative flex h-9 flex-1 items-center pr-14 sm:pr-20">
                  <div className="relative h-full w-full">
                    {TICKS.slice(1, -1).map((t) => (
                      <span key={t} className="absolute inset-y-0 w-px bg-border/60" style={{ left: `${t * 100}%` }} />
                    ))}
                    <span
                      className={cn(
                        "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm",
                        color,
                        d.collapsed && "opacity-70",
                        progress && "running-bar rounded-r-none",
                        stalled && "stalled",
                      )}
                      style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%`, ...(d.collapsed && COLLAPSED_BAR) }}
                    />
                  </div>
                  <span className="absolute right-2 text-xs tabular-nums sm:right-3 text-muted-foreground">
                    {progress ? <Elapsed progress={progress} /> : formatDuration(row.span.duration_ms)}
                  </span>
                </div>
              </button>
              {open && (
                <div
                  className="border-t bg-muted/10 py-4 pl-[calc(12px+var(--depth)*8px)] pr-3 sm:pl-[calc(28px+var(--depth)*16px)] sm:pr-4 md:pr-8"
                  style={{ "--depth": row.depth } as CSSProperties}
                >
                  {details(row.span)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
