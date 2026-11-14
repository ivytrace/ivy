import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { format } from "date-fns";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { ErrorState, LoadingState } from "@/components/common/states";
import type { TimeseriesPoint } from "@/lib/api/types";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

export type Metric = "invocations" | "errors" | "p95_ms" | "throttles";

const tickFormat = (points: TimeseriesPoint[]) => {
  if (points.length < 2) return "HH:mm";
  const span = new Date(points[points.length - 1].ts).getTime() - new Date(points[0].ts).getTime();
  return span > 2 * 86_400_000 ? "MMM d" : "HH:mm";
};

export function summarize(points: TimeseriesPoint[] | undefined, metric: Metric): number | undefined {
  if (!points) return undefined;
  if (metric !== "p95_ms") return points.reduce((acc, p) => acc + p[metric], 0);
  const nonZero = points.filter((p) => p.p95_ms > 0);
  return nonZero.length ? Math.max(...nonZero.map((p) => p.p95_ms)) : 0;
}

export function TimeseriesChart({
  title,
  points,
  error,
  metric,
  color = "var(--chart-1)",
  suffix = "",
  summaryLabel,
  stacked,
}: {
  title: string;
  points?: TimeseriesPoint[];
  error?: unknown;
  metric: Metric;
  color?: string;
  suffix?: string;
  summaryLabel?: string;
  /** A second count series stacked on top (e.g. throttles on the errors chart), shown only when it has data. */
  stacked?: { metric: Metric; label: string; color: string };
}) {
  const total = summarize(points, metric);
  const stackedTotal = stacked ? summarize(points, stacked.metric) : undefined;
  const showStacked = stacked && !!stackedTotal;
  const fmt = points ? tickFormat(points) : "HH:mm";

  return (
    <div className="rounded-md border px-5 pb-3 pt-5">
      <h3 className="pb-3 pl-1 text-sm">
        <span className="font-semibold">{title}</span>{" "}
        {total !== undefined && (
          <span className="text-muted-foreground">
            {summaryLabel ? `${summaryLabel} ` : ""}
            {formatNumber(total)}
            {suffix}
          </span>
        )}
        {showStacked && (
          <span className="text-muted-foreground">
            {" · "}
            <span className="inline-block size-2 rounded-sm align-middle" style={{ background: stacked.color }} />{" "}
            {formatNumber(stackedTotal)} {stacked.label.toLowerCase()}
          </span>
        )}
      </h3>
      {error ? (
        <ErrorState error={error} className="h-[160px] p-0" />
      ) : !points ? (
        <LoadingState className="h-[160px] p-0" />
      ) : (
        <ChartContainer
          config={{
            [metric]: { label: stacked ? metricLabel(metric) : title, color },
            ...(showStacked && { [stacked.metric]: { label: stacked.label, color: stacked.color } }),
          }}
          className="aspect-auto h-[160px] w-full"
        >
          <BarChart accessibilityLayer data={points}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="ts"
              tickLine={false}
              tickMargin={8}
              axisLine={false}
              minTickGap={30}
              tickFormatter={(v: string) => format(new Date(v), fmt)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const ts = (payload?.[0]?.payload as TimeseriesPoint | undefined)?.ts;
                    return ts ? format(new Date(ts), "PP HH:mm") : "";
                  }}
                  valueFormatter={(v) => `${formatNumber(v)}${suffix}`}
                />
              }
            />
            <Bar dataKey={metric} fill={color} radius={showStacked ? 0 : 3} stackId="a" isAnimationActive={false} />
            {showStacked && (
              <Bar dataKey={stacked.metric} fill={stacked.color} radius={[3, 3, 0, 0]} stackId="a" isAnimationActive={false} />
            )}
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}

const metricLabel = (m: Metric) => ({ invocations: "Invocations", errors: "Errors", p95_ms: "p95", throttles: "Throttles" })[m];

export function Sparkline({
  points,
  metric,
  color = "var(--chart-1)",
  className,
}: {
  points?: TimeseriesPoint[];
  metric: Metric;
  color?: string;
  className?: string;
}) {
  return (
    <div className={cn("h-9 w-full min-w-28 rounded-md border px-1.5 pt-1.5", className)}>
      {points && (
        <ChartContainer config={{ [metric]: { label: metric, color } }} className="aspect-auto h-full w-full">
          <BarChart data={points} margin={{ top: 0, left: 0, right: 0, bottom: 0 }}>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const ts = (payload?.[0]?.payload as TimeseriesPoint | undefined)?.ts;
                    return ts ? format(new Date(ts), "PP HH:mm") : "";
                  }}
                  valueFormatter={(v) => formatNumber(v)}
                />
              }
            />
            <Bar dataKey={metric} fill={color} radius={2} isAnimationActive={false} />
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
