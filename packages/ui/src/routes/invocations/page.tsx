import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Search, X } from "lucide-react";

import { DataTable } from "@/components/tables/data-table";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { ColdStart, InvocationStatus } from "@/components/common/status";
import { TimeseriesChart } from "@/components/stats/timeseries-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useTimeRange } from "@/components/layout/time-range";
import { useFunctions, useInvocations, useTimeseries } from "@/lib/api/hooks";
import type { Invocation } from "@/lib/api/types";
import { ALL_PROJECTS, errorsLink, invocationsLink, pageLink, rowScope, traceLink, type Scope } from "@/lib/links/links";
import { useScope } from "@/lib/links/use-scope";
import { triggerLabel } from "@/lib/spans/services";
import { formatAgo, formatDuration, formatNumber, formatTimestamp } from "@/lib/utils/format";

const PAGE_SIZE = 50;
const ALL = "__all";

function columnsFor(scope: Scope): ColumnDef<Invocation, unknown>[] {
  const all = scope.project === ALL_PROJECTS;
  // Under "All projects" a row opens in its own project: traces only exist per project.
  const linkTo = (inv: Invocation) => traceLink(rowScope(scope, inv), inv.trace_id, inv.span_id);
  return [
  {
    accessorKey: "ts",
    header: "Time",
    cell: ({ row }) => (
      <Tooltipped title={formatTimestamp(row.original.ts)}>
        <Link to={linkTo(row.original)} className="whitespace-nowrap font-medium text-primary hover:underline">
          {formatAgo(row.original.ts)}
        </Link>
      </Tooltipped>
    ),
  },
  {
    accessorKey: "function",
    header: "Function",
    cell: ({ row }) => (
      <Link
        to={invocationsLink(rowScope(scope, row.original), { function: row.original.function })}
        className="block max-w-56 truncate hover:underline"
      >
        {row.original.function}
      </Link>
    ),
  },
  ...(all
    ? [
        {
          id: "project",
          accessorFn: (inv: Invocation) => inv.project ?? "",
          header: "Project",
          cell: ({ row }: { row: { original: Invocation } }) =>
            row.original.project ? (
              <Link to={pageLink(rowScope(scope, row.original), "functions")} className="whitespace-nowrap font-mono text-xs text-muted-foreground hover:text-foreground">
                {row.original.project}
              </Link>
            ) : null,
        } satisfies ColumnDef<Invocation, unknown>,
      ]
    : []),
  {
    accessorKey: "status",
    header: "Result",
    cell: ({ row }) => (
      <InvocationStatus
        ok={row.original.status === "ok"}
        errorType={row.original.error_type}
        errorMessage={row.original.error_message}
        httpStatus={row.original.http_status}
        failureKind={row.original.failure_kind}
      />
    ),
  },
  {
    accessorKey: "trigger",
    header: "Trigger",
    cell: ({ row }) => {
      const { http_method, http_path, trigger } = row.original;
      return http_method && http_path ? (
        <code className="whitespace-nowrap text-xs">
          {http_method} {http_path}
        </code>
      ) : (
        <span className="text-muted-foreground">{triggerLabel(trigger)}</span>
      );
    },
  },
  {
    accessorKey: "duration_ms",
    header: "Duration",
    cell: ({ row }) => (
      <span className="flex items-center gap-2 whitespace-nowrap tabular-nums">
        {formatDuration(row.original.duration_ms)}
        {row.original.cold_start && <ColdStart />}
      </span>
    ),
  },
  {
    accessorKey: "request_id",
    header: "Request ID",
    cell: ({ row }) => (
      <Link to={linkTo(row.original)} className="font-mono text-xs text-muted-foreground hover:text-foreground">
        {row.original.request_id || <span className="font-sans italic">no request</span>}
      </Link>
    ),
  },
];
}

function useFilterParams() {
  const [params, setParams] = useSearchParams();
  const fn = params.get("function") ?? undefined;
  const status = (params.get("status") as "ok" | "error" | null) ?? undefined;
  const q = params.get("q") ?? undefined;
  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  return { fn, status, q, update };
}

export default function Invocations() {
  const scope = useScope();
  const all = scope.project === ALL_PROJECTS;
  const columns = useMemo(() => columnsFor(scope), [scope.workspace, scope.project]);
  const { range } = useTimeRange();
  const { fn, status, q, update } = useFilterParams();
  const [cursors, setCursors] = useState<string[]>([]);
  const [search, setSearch] = useState(q ?? "");

  const filterKey = JSON.stringify([range, fn, status, q]);
  useEffect(() => {
    setCursors([]);
    setSearch(q ?? "");
  }, [filterKey, q]);

  const cursor = cursors[cursors.length - 1];
  const { data, error, isLoading, isValidating, mutate } = useInvocations(range, {
    function: fn,
    status,
    q,
    cursor,
    limit: PAGE_SIZE,
  });
  const functions = useFunctions(range);
  const series = useTimeseries(range, { function: fn });

  // Under "All projects" a function name can exist in several projects: its rows add up.
  const throttles = fn ? (functions.data?.items.filter((f) => f.name === fn).reduce((n, f) => n + f.throttles, 0) ?? 0) : 0;
  const functionNames = [...new Set([...(functions.data?.items.map((f) => f.name) ?? []), ...(fn ? [fn] : [])])].sort();

  return (
    <div>
      <h1 className="text-2xl font-bold">{fn ?? "Invocations"}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        {fn
          ? `Invocations of this function${all ? " in every project that has it" : ""}.`
          : `All traced invocations${all ? " of every project" : ""}, newest first.`}
      </p>
      {throttles > 0 && (
        <p className="text-sm">
          <span className="font-medium text-orange-400">{formatNumber(throttles)} throttled</span>
          <span className="text-muted-foreground">
            {" "}
            requests in this time range. Lambda rejected them before they reached the function, so they have no traces.{" "}
          </span>
          <Link to={errorsLink(scope, fn)} className="text-primary hover:underline">
            Errors
          </Link>
        </p>
      )}

      {fn && (
        <div className="my-5 grid gap-5 md:grid-cols-3">
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
      )}

      <div className="flex flex-wrap items-center gap-3 py-4">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() || undefined });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-2 size-4 text-muted-foreground" />
          <Input
            placeholder="Request ID, trace ID, error, path…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => search.trim() !== (q ?? "") && update({ q: search.trim() || undefined })}
            className="h-8 w-80 pl-9"
            aria-label="Search invocations"
          />
        </form>
        <Select value={fn ?? ALL} onValueChange={(v) => update({ function: v === ALL ? undefined : v })}>
          <SelectTrigger className="h-8 w-56" aria-label="Function">
            <SelectValue placeholder="All functions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All functions</SelectItem>
            {functionNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status ?? ALL} onValueChange={(v) => update({ status: v === ALL ? undefined : v })}>
          <SelectTrigger className="h-8 w-36" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            <SelectItem value="ok">Successful</SelectItem>
            <SelectItem value="error">Failed</SelectItem>
          </SelectContent>
        </Select>
        {(fn || status || q) && (
          <Button variant="ghost" size="sm" onClick={() => update({ function: undefined, status: undefined, q: undefined })}>
            <X className="mr-1 size-4" />
            Reset
          </Button>
        )}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} className="rounded-md border" />
      ) : isLoading || !data ? (
        <LoadingState className="rounded-md border" />
      ) : (
        <div className={isValidating ? "opacity-70 transition-opacity" : undefined}>
          <DataTable
            columns={columns}
            data={data.items}
            manualSorting
            getRowId={(i) => i.span_id + i.trace_id}
            empty={<EmptyState title="No invocations" description="Nothing matches these filters in this time range." />}
          />
        </div>
      )}

      <div className="flex items-center justify-between py-4">
        <div className="text-xs text-muted-foreground">
          Page {cursors.length + 1}
          {data ? ` (${data.items.length} items)` : ""}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setCursors((c) => c.slice(0, -1))} disabled={!cursors.length}>
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => data?.next_cursor && setCursors((c) => [...c, data.next_cursor!])}
            disabled={!data?.next_cursor}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
