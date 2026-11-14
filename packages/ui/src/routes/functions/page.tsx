import { Link } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/tables/data-table";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Sparkline, TimeseriesChart } from "@/components/stats/timeseries-chart";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useTimeRange } from "@/components/layout/time-range";
import { useFunctions, useTimeseries } from "@/lib/api/hooks";
import type { FunctionSummary } from "@/lib/api/types";
import { invocationsLink } from "@/lib/links/links";
import { formatAgo, formatDuration, formatNumber, formatPercent } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

function FunctionSparkline({ name, metric }: { name: string; metric: "invocations" | "errors" }) {
  const { range } = useTimeRange();
  const { data } = useTimeseries(range, { function: name });
  return (
    <Sparkline
      points={data?.items}
      metric={metric}
      color={metric === "errors" ? "var(--chart-2)" : "var(--chart-1)"}
      className="w-40"
    />
  );
}

const columns: ColumnDef<FunctionSummary, unknown>[] = [
  {
    accessorKey: "name",
    header: "Function",
    cell: ({ row }) => (
      <Link to={invocationsLink({ function: row.original.name })} className="block">
        <span className="block font-semibold text-primary">{row.original.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.region}</span>
      </Link>
    ),
  },
  {
    accessorKey: "invocations",
    header: "Invocations",
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <FunctionSparkline name={row.original.name} metric="invocations" />
        <span className="tabular-nums">{formatNumber(row.original.invocations)}</span>
      </div>
    ),
  },
  {
    accessorKey: "errors",
    header: "Errors",
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <FunctionSparkline name={row.original.name} metric="errors" />
        <Link
          to={invocationsLink({ function: row.original.name, status: "error" })}
          className={cn("tabular-nums hover:underline", row.original.errors > 0 && "text-red-400")}
        >
          {formatNumber(row.original.errors)}
          <span className="ml-1 text-xs text-muted-foreground">({formatPercent(row.original.error_rate)})</span>
        </Link>
      </div>
    ),
  },
  {
    accessorKey: "cold_starts",
    header: "Cold starts",
    cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.cold_starts)}</span>,
  },
  {
    accessorKey: "p50_ms",
    header: "Duration",
    cell: ({ row }) => {
      const f = row.original;
      return (
        <Tooltipped
          title={`avg ${formatDuration(f.avg_ms)} · p50 ${formatDuration(f.p50_ms)} · p95 ${formatDuration(f.p95_ms)} · p99 ${formatDuration(f.p99_ms)}`}
        >
          <span className="whitespace-nowrap tabular-nums">
            {formatDuration(f.p50_ms)}
            <span className="text-xs text-muted-foreground"> p50 · </span>
            {formatDuration(f.p95_ms)}
            <span className="text-xs text-muted-foreground"> p95</span>
          </span>
        </Tooltipped>
      );
    },
  },
  {
    accessorKey: "last_invoked",
    header: "Last invoked",
    cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatAgo(row.original.last_invoked)}</span>,
  },
];

export default function Functions() {
  const { range } = useTimeRange();
  const functions = useFunctions(range);
  const series = useTimeseries(range);

  return (
    <div>
      <h1 className="text-2xl font-bold">Functions</h1>
      <p className="mb-4 text-sm text-muted-foreground">Functions start appearing after their first traced invocation.</p>
      <div className="my-5 mb-8 grid gap-5 md:grid-cols-3">
        <TimeseriesChart title="Invocations" points={series.data?.items} error={series.error} metric="invocations" />
        <TimeseriesChart
          title="Errors"
          points={series.data?.items}
          error={series.error}
          metric="errors"
          color="var(--chart-2)"
        />
        <TimeseriesChart
          title="p95 duration"
          points={series.data?.items}
          error={series.error}
          metric="p95_ms"
          color="var(--chart-3)"
          suffix=" ms"
          summaryLabel="max"
        />
      </div>
      {functions.error ? (
        <ErrorState error={functions.error} onRetry={() => void functions.mutate()} className="rounded-md border" />
      ) : !functions.data ? (
        <LoadingState className="rounded-md border" />
      ) : (
        <DataTable
          columns={columns}
          data={functions.data.items}
          getRowId={(f) => `${f.region}/${f.name}`}
          defaultSorting={[{ id: "invocations", desc: true }]}
          empty={
            <EmptyState
              title="No functions in this time range"
              description="Attach the Ivy layer to a Lambda function and invoke it, or pick a longer time range."
            />
          }
        />
      )}
    </div>
  );
}
