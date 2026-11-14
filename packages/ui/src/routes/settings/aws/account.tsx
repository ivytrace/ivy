import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, MapPin, RefreshCw, Trash2 } from "lucide-react";

import { AccountStatus, DeleteAccountDialog, EditRegionsDialog, FunctionCounts } from "@/components/aws/account-parts";
import { regionSummary } from "@/components/aws/region-picker";
import { TRACE_STATE_LABELS, TraceStateLabel, TracingToggle } from "@/components/aws/trace-state";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { refreshAws, syncAwsAccount } from "@/lib/api/aws";
import { useAwsAccount, useAwsFunctions } from "@/lib/api/hooks";
import type { AwsFunction, TraceState } from "@/lib/api/types";
import { AWS_ACCOUNTS_PATH, invocationsLink } from "@/lib/links/links";
import { cn } from "@/lib/utils/cn";
import { formatAgo } from "@/lib/utils/format";

const FILTERS: (TraceState | "all")[] = ["all", "traced", "opted_out", "conflict", "error", "pending", "unsupported"];

function columns(onError: (message: string) => void): ColumnDef<AwsFunction, unknown>[] {
  return [
    {
      accessorKey: "name",
      header: "Function",
      cell: ({ row }) => (
        <div>
          <Link to={invocationsLink({ function: row.original.name })} className="font-semibold text-primary hover:underline">
            {row.original.name}
          </Link>
          <div className="text-xs text-muted-foreground">{row.original.region}</div>
        </div>
      ),
    },
    {
      accessorKey: "runtime",
      header: "Runtime",
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.runtime || "—"}</span>,
    },
    {
      accessorKey: "state",
      header: "State",
      cell: ({ row }) => <TraceStateLabel state={row.original.state} />,
    },
    {
      accessorKey: "reason",
      header: "Details",
      enableSorting: false,
      meta: { className: "max-w-md" },
      cell: ({ row }) => (
        <span className="line-clamp-2 text-xs text-muted-foreground" title={row.original.reason ?? undefined}>
          {row.original.reason ?? ""}
        </span>
      ),
    },
    {
      id: "tracing",
      header: "Tracing",
      enableSorting: false,
      cell: ({ row }) => <TracingToggle fn={row.original} onError={onError} />,
    },
  ];
}

export default function AwsAccountPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const account = useAwsAccount(id);
  const functions = useAwsFunctions(account.data?.account_id, { refreshInterval: account.data?.syncing ? 3000 : 30_000 });
  const [params, setParams] = useSearchParams();
  const filter = (params.get("state") as TraceState | null) ?? "all";
  const [q, setQ] = useState("");
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const cols = useMemo(() => columns(setToggleError), []);
  const rows = useMemo(
    () =>
      (account.data ? (functions.data?.items ?? []) : []).filter(
        (f) => (filter === "all" || f.state === filter) && (!q || f.name.toLowerCase().includes(q.toLowerCase())),
      ),
    [functions.data, account.data, filter, q],
  );

  const setFilter = (state: TraceState | "all") => {
    const next = new URLSearchParams(params);
    if (state === "all") next.delete("state");
    else next.set("state", state);
    setParams(next, { replace: true });
  };

  if (account.error) return <ErrorState error={account.error} onRetry={() => void account.mutate()} className="rounded-md border" />;
  if (!account.data) return <LoadingState className="rounded-md border" />;
  const a = account.data;

  const sync = async () => {
    setSyncing(true);
    try {
      await syncAwsAccount(a.id);
      await refreshAws();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <Link to={AWS_ACCOUNTS_PATH} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        AWS accounts
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{a.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="font-mono">{a.account_id}</span>
            <AccountStatus account={a} />
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" />
              {regionSummary(a)}
            </span>
            <span>{a.last_sync_at ? `Synced ${formatAgo(a.last_sync_at)}` : "Not synced yet"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void sync()} disabled={syncing || a.syncing || a.status === "pending"}>
            <RefreshCw className={cn("mr-2 size-4", (syncing || a.syncing) && "animate-spin")} />
            Sync now
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <MapPin className="mr-2 size-4" />
            Regions
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
            <Trash2 className="mr-2 size-4" />
            Disconnect
          </Button>
        </div>
      </div>

      {a.error && (
        <pre className="mb-4 whitespace-pre-wrap break-words rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 font-mono text-xs text-amber-300">
          {a.error}
        </pre>
      )}
      {toggleError && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-300">
          {toggleError}
          <button type="button" className="text-xs underline" onClick={() => setToggleError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((state) => {
            const count = state === "all" ? a.counts.total : a.counts[state];
            if (state !== "all" && state !== "traced" && !count) return null;
            return (
              <Button key={state} size="sm" variant={filter === state ? "secondary" : "ghost"} onClick={() => setFilter(state)}>
                {state === "all" ? "All" : TRACE_STATE_LABELS[state]}
                <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
              </Button>
            );
          })}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter functions…" className="h-8 w-56" />
      </div>

      {functions.error ? (
        <ErrorState error={functions.error} onRetry={() => void functions.mutate()} className="rounded-md border" />
      ) : !functions.data ? (
        <LoadingState className="rounded-md border" />
      ) : (
        <DataTable
          columns={cols}
          data={rows}
          getRowId={(f) => `${f.region}/${f.name}`}
          defaultSorting={[{ id: "name", desc: false }]}
          empty={
            <EmptyState
              title={a.counts.total ? "No functions match" : a.syncing ? "Scanning functions…" : "No functions found"}
              description={a.counts.total ? undefined : <>Ivy found no Lambda functions in {regionSummary(a)}.</>}
            />
          }
        />
      )}
      {a.counts.total > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          <FunctionCounts counts={a.counts} onSelect={setFilter} />
          <span className="mt-2 block">
            Tag a function with <span className="font-mono">ivy:trace=false</span> to keep it untraced from your infrastructure code.
          </span>
        </p>
      )}

      <EditRegionsDialog account={editing ? a : null} onOpenChange={setEditing} />
      <DeleteAccountDialog account={deleting ? a : null} onOpenChange={setDeleting} onDeleted={() => navigate(AWS_ACCOUNTS_PATH)} />
    </div>
  );
}
