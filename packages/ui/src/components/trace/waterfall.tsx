import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { ServiceIcon } from "@/components/common/service-icon";
import { SpanDetails } from "@/components/trace/span-details";
import { SpanTitle } from "@/components/trace/span-title";
import { describeSpan, type ServiceIcon as Icon } from "@/lib/spans/services";
import type { WaterfallRow } from "@/lib/spans/tree";
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
  return (
    <div className="rounded-md border text-sm">
      <div className="flex border-b text-xs text-muted-foreground">
        <div className="w-[48%] shrink-0 px-4 py-2">Span</div>
        <div className="relative flex-1 py-2 pr-20">
          <div className="relative h-4">
            {TICKS.map((t) => (
              <span
                key={t}
                className={cn("absolute whitespace-nowrap", t === 1 ? "-translate-x-full" : t > 0 && "-translate-x-1/2")}
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
          return (
            <div key={row.span.span_id} id={`span-${row.span.span_id}`} className="transition-colors">
              <button
                type="button"
                onClick={() => onToggle(row.span.span_id)}
                aria-expanded={open}
                className={cn("flex w-full items-center text-left hover:bg-muted/40", open && "bg-muted/30")}
              >
                <div
                  className="flex w-[48%] shrink-0 items-center gap-2 py-2 pr-3"
                  style={{ paddingLeft: `${12 + row.depth * 16}px` }}
                >
                  <ChevronRight
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                  />
                  <ServiceIcon icon={d.icon} label={d.serviceLabel} />
                  <span className={cn("min-w-0 flex-1 truncate", d.isError && "text-red-400")}>
                    <SpanTitle description={d} />
                  </span>
                </div>
                <div className="relative flex h-9 flex-1 items-center pr-20">
                  <div className="relative h-full w-full">
                    {TICKS.slice(1, -1).map((t) => (
                      <span key={t} className="absolute inset-y-0 w-px bg-border/60" style={{ left: `${t * 100}%` }} />
                    ))}
                    <span
                      className={cn(
                        "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm",
                        d.isError ? "bg-red-400" : (BAR_COLORS[d.icon] ?? "bg-zinc-400"),
                      )}
                      style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%` }}
                    />
                  </div>
                  <span className="absolute right-3 text-xs tabular-nums text-muted-foreground">
                    {formatDuration(row.span.duration_ms)}
                  </span>
                </div>
              </button>
              {open && (
                <div className="border-t bg-muted/10 px-4 py-4 md:px-8" style={{ paddingLeft: `${28 + row.depth * 16}px` }}>
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
