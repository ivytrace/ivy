import { Link, useSearchParams } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/tables/data-table";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { FailureBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useTimeRange } from "@/components/layout/time-range";
import { useErrors, useFunctions } from "@/lib/api/hooks";
import type { ErrorGroup } from "@/lib/api/types";
import { invocationsLink, traceLink } from "@/lib/links/links";
import { formatAgo, formatNumber, formatTimestamp } from "@/lib/utils/format";

const ALL = "__all";

const columns: ColumnDef<ErrorGroup, unknown>[] = [
  {
    accessorKey: "error_type",
    header: "Error",
    cell: ({ row }) => (
      <Link to={traceLink(row.original.sample_trace_id)} className="block max-w-2xl">
        <span className="flex items-center gap-2">
          {row.original.failure_kind && <FailureBadge kind={row.original.failure_kind} hint={false} />}
          <span className="font-semibold text-red-400">{row.original.error_type}</span>
        </span>
        <span className="mt-0.5 block line-clamp-2 text-muted-foreground">{row.original.error_message}</span>
      </Link>
    ),
  },
  {
    accessorKey: "function",
    header: "Function",
    cell: ({ row }) => (
      <Link to={invocationsLink({ function: row.original.function })} className="font-medium text-primary hover:underline">
        {row.original.function}
      </Link>
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
      <Tooltipped title={`First seen ${formatTimestamp(row.original.first_seen)}`}>
        <span className="whitespace-nowrap text-muted-foreground">{formatAgo(row.original.last_seen)}</span>
      </Tooltipped>
    ),
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    meta: { className: "text-right" },
    cell: ({ row }) => (
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to={traceLink(row.original.sample_trace_id)}>Sample trace</Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link
            to={invocationsLink({
              function: row.original.function,
              status: "error",
              q: row.original.error_message.slice(0, 120),
            })}
          >
            Invocations
          </Link>
        </Button>
      </div>
    ),
  },
];

export default function Errors() {
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
        Failed invocations, grouped by function, error type and normalized message.
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
          getRowId={(g) => g.fingerprint}
          defaultSorting={[{ id: "count", desc: true }]}
          empty={<EmptyState title="No errors" description="No failed invocations in this time range." />}
        />
      )}
    </div>
  );
}
