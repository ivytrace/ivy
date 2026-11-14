import { Link } from "react-router";
import { Cloud, Plus } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/tables/data-table";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { TraceStateLabel, TracingToggle } from "@/components/aws/trace-state";
import { Button } from "@/components/ui/button";
import { Sparkline, TimeseriesChart } from "@/components/stats/timeseries-chart";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useTimeRange } from "@/components/layout/time-range";
import { sparklineBucket, useAwsAccounts, useAwsFunctions, useFunctions, useTimeseries } from "@/lib/api/hooks";
import type { FunctionSummary } from "@/lib/api/types";
import { AWS_ACCOUNTS_PATH, errorsLink, invocationsLink } from "@/lib/links/links";
import { formatAgo, formatDuration, formatNumber, formatPercent } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

function FunctionSparkline({ name, metric }: { name: string; metric: "invocations" | "errors" }) {
  const { range } = useTimeRange();
  const { data } = useTimeseries(range, { function: name, bucket: sparklineBucket(range) });
  return (
    <Sparkline
      points={data?.items}
      metric={metric}
      color={metric === "errors" ? "var(--chart-2)" : "var(--chart-1)"}
      className="w-40"
    />
  );
}

/** Auto-trace state of a function seen in traces, matched by region + name. */
function TracingCell({ fn }: { fn: FunctionSummary }) {
  const { data } = useAwsFunctions();
  const aws = data?.items.find((f) => f.name === fn.name && f.region === fn.region);
  if (!aws) {
    return (
      <Tooltipped title="Not in a connected AWS account (layer attached manually)">
        <span className="text-xs text-muted-foreground">Manual</span>
      </Tooltipped>
    );
  }
  return (
    <span className="flex items-center gap-3">
      <TracingToggle fn={aws} />
      <TraceStateLabel state={aws.state} reason={aws.reason} />
    </span>
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
    accessorKey: "throttles",
    header: "Throttles",
    cell: ({ row }) =>
      row.original.throttles > 0 ? (
        <Tooltipped title="Requests Lambda rejected (concurrency limit). They never reached the function, so they have no traces.">
          <Link to={errorsLink(row.original.name)} className="tabular-nums text-orange-400 hover:underline">
            {formatNumber(row.original.throttles)}
          </Link>
        </Tooltipped>
      ) : (
        <span className="tabular-nums text-muted-foreground">0</span>
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
    cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{row.original.last_invoked ? formatAgo(row.original.last_invoked) : "–"}</span>,
  },
  {
    id: "tracing",
    header: "Tracing",
    enableSorting: false,
    cell: ({ row }) => <TracingCell fn={row.original} />,
  },
];

function ConnectAccount() {
  return (
    <div className="flex flex-col items-center gap-3 p-10 text-center text-sm">
      <Cloud className="size-6 text-muted-foreground" />
      <div>
        <div className="font-medium">Connect an AWS account to start tracing</div>
        <div className="mt-1 max-w-md text-muted-foreground">
          Ivy attaches its layer to your Node.js Lambda functions. Traces show up here after their next invocation.
        </div>
      </div>
      <Button asChild>
        <Link to={`${AWS_ACCOUNTS_PATH}?connect=1`}>
          <Plus className="mr-2 size-4" />
          Connect AWS account
        </Link>
      </Button>
    </div>
  );
}

export default function Functions() {
  const { range } = useTimeRange();
  const functions = useFunctions(range);
  const series = useTimeseries(range);
  const accounts = useAwsAccounts();
  const noAccounts = accounts.data?.items.length === 0;

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
          stacked={{ metric: "throttles", label: "Throttled", color: "var(--chart-4)" }}
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
            noAccounts ? (
              <ConnectAccount />
            ) : (
              <EmptyState
                title="No functions in this time range"
                description="Traced functions appear after their first invocation. Pick a longer time range, or check the AWS accounts page."
              />
            )
          }
        />
      )}
    </div>
  );
}
