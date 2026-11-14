import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight } from "lucide-react";

import { DataTable } from "@/components/tables/data-table";
import { ErrorTemplate, GroupMessages, variantsLabel } from "@/components/errors/error-template";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { FailureBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useTimeRange } from "@/components/layout/time-range";
import { useErrors, useFunctions } from "@/lib/api/hooks";
import type { ErrorGroup } from "@/lib/api/types";
import { ALL_PROJECTS, invocationsLink, pageLink, rowScope, traceLink, type Scope } from "@/lib/links/links";
import { useScope } from "@/lib/links/use-scope";
import { formatAgo, formatNumber, formatTimestamp } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const ALL = "__all";

const expandable = (g: ErrorGroup) => g.kind !== "throttle" && g.variants > 1 && g.top_messages.length > 0;

function columnsFor(scope: Scope): ColumnDef<ErrorGroup, unknown>[] {
  const all = scope.project === ALL_PROJECTS;
  return [
  {
    id: "expand",
    header: "",
    enableSorting: false,
    meta: { className: "w-8 pr-0" },
    cell: ({ row }) =>
      expandable(row.original) ? (
        <button
          type="button"
          aria-label={row.getIsExpanded() ? "Hide messages" : "Show messages"}
          aria-expanded={row.getIsExpanded()}
          onClick={row.getToggleExpandedHandler()}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-4 transition-transform", row.getIsExpanded() && "rotate-90")} />
        </button>
      ) : null,
  },
  {
    accessorKey: "error_type",
    header: "Error",
    cell: ({ row }) => {
      const g = row.original;
      if (g.kind === "throttle") {
        return (
          <Link to={invocationsLink(rowScope(scope, g), { function: g.function })} className="block max-w-2xl">
            <span className="font-semibold text-orange-400">Throttled</span>
            <span className="mt-0.5 block line-clamp-2 text-muted-foreground">{g.error_message}</span>
          </Link>
        );
      }
      return (
        <Link to={traceLink(rowScope(scope, g), g.sample_trace_id ?? "")} className="block max-w-2xl">
          <span className="flex items-center gap-2">
            {g.failure_kind && <FailureBadge kind={g.failure_kind} hint={false} />}
            <span className="font-semibold text-red-400">{g.error_type}</span>
          </span>
          <ErrorTemplate template={g.error_template} className="mt-0.5 block line-clamp-2 text-muted-foreground" />
        </Link>
      );
    },
  },
  {
    accessorKey: "function",
    header: "Function",
    cell: ({ row }) => (
      <Link to={invocationsLink(rowScope(scope, row.original), { function: row.original.function })} className="link">
        {row.original.function}
      </Link>
    ),
  },
  ...(all
    ? [
        {
          id: "project",
          accessorFn: (g: ErrorGroup) => g.project ?? "",
          header: "Project",
          cell: ({ row }: { row: { original: ErrorGroup } }) =>
            row.original.project ? (
              <Link to={pageLink(rowScope(scope, row.original), "errors")} className="whitespace-nowrap font-mono text-xs text-muted-foreground hover:text-foreground">
                {row.original.project}
              </Link>
            ) : null,
        } satisfies ColumnDef<ErrorGroup, unknown>,
      ]
    : []),
  {
    accessorKey: "variants",
    header: "Variants",
    cell: ({ row }) =>
      row.original.kind === "throttle" || row.original.variants <= 1 ? null : expandable(row.original) ? (
        <button
          type="button"
          onClick={row.getToggleExpandedHandler()}
          className="whitespace-nowrap tabular-nums text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {variantsLabel(row.original.variants)}
        </button>
      ) : (
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">{variantsLabel(row.original.variants)}</span>
      ),
  },
  {
    accessorKey: "count",
    header: "Occurrences",
    cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.count)}</span>,
  },
  {
    accessorKey: "last_seen",
    header: "Last seen",
    cell: ({ row }) => (
      <div className="whitespace-nowrap">
        <Tooltipped title={formatTimestamp(row.original.last_seen)}>
          <span className="text-muted-foreground">{formatAgo(row.original.last_seen)}</span>
        </Tooltipped>
        <Tooltipped title={formatTimestamp(row.original.first_seen)}>
          <span className="block text-xs text-zinc-500">first {formatAgo(row.original.first_seen)}</span>
        </Tooltipped>
      </div>
    ),
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    meta: { className: "text-right" },
    cell: ({ row }) =>
      row.original.kind === "throttle" ? (
        <div className="flex justify-end gap-2">
          <Tooltipped title="Throttled requests never reach the function, so there is no trace">
            <span className="self-center px-3 text-xs text-muted-foreground">No trace</span>
          </Tooltipped>
          <Button variant="outline" size="sm" asChild>
            <Link to={invocationsLink(rowScope(scope, row.original), { function: row.original.function })}>Function</Link>
          </Button>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to={traceLink(rowScope(scope, row.original), row.original.sample_trace_id ?? "")}>Sample trace</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link
              to={invocationsLink(rowScope(scope, row.original), { function: row.original.function, group: row.original.fingerprint })}
            >
              Invocations
            </Link>
          </Button>
        </div>
      ),
  },
  ];
}

export default function Errors() {
  const scope = useScope();
  const columns = useMemo(() => columnsFor(scope), [scope.workspace, scope.project]);
  const { range } = useTimeRange();
  const [params, setParams] = useSearchParams();
  const fn = params.get("function") ?? undefined;
  const { data, error, mutate } = useErrors(range, fn);
  const functions = useFunctions(range);
  const names = [...new Set([...(functions.data?.items.map((f) => f.name) ?? []), ...(fn ? [fn] : [])])].sort();

  return (
    <div>
      <h1 className="text-2xl font-bold">Errors</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Failed invocations, grouped by function, error type, code location and message pattern
        {scope.project === ALL_PROJECTS ? ", across all projects" : ""}: IDs, paths and numbers in a message don&apos;t split a group.
        Throttled requests are counted per function; they never reached the function, so they have no trace.
      </p>
      <div className="py-4">
        <Select
          value={fn ?? ALL}
          onValueChange={(v) => setParams(v === ALL ? {} : { function: v }, { replace: true })}
        >
          <SelectTrigger className="h-8 w-56" aria-label="Function">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All functions</SelectItem>
            {names.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} className="rounded-md border" />
      ) : !data ? (
        <LoadingState className="rounded-md border" />
      ) : (
        <DataTable
          columns={columns}
          data={data.items}
          getRowId={(g) => `${g.project_id ?? ""}/${g.fingerprint}/${g.function}`}
          renderExpanded={(g) => (expandable(g) ? <GroupMessages group={g} scope={rowScope(scope, g)} /> : null)}
          defaultSorting={[{ id: "count", desc: true }]}
          empty={<EmptyState title="No errors" description="No failed invocations in this time range." />}
        />
      )}
    </div>
  );
}
