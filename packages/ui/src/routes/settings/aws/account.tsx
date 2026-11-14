import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, MapPin, RefreshCw, Trash2 } from "lucide-react";

import { AccountStatus, DeleteAccountDialog, EditRegionsDialog, FunctionCounts } from "@/components/aws/account-parts";
import { FunctionPicker } from "@/components/aws/function-picker";
import { regionSummary } from "@/components/aws/region-picker";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { refreshAws, syncAwsAccount, updateAwsAccount } from "@/lib/api/aws";
import { useAwsAccount, useAwsAccountFunctions } from "@/lib/api/hooks";
import { awsAccountsLink } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";
import { formatAgo } from "@/lib/utils/format";

export default function AwsAccountPage() {
  const { id } = useParams();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const account = useAwsAccount(id);
  const functions = useAwsAccountFunctions(account.data?.id, { refreshInterval: account.data?.syncing ? 3000 : 30_000 });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Opening the list counts as reviewing it: a few seconds in, the account's "new" badge is cleared
  // (the rows keep their "new" marks until the next refresh).
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => void updateAwsAccount(workspace, id, { reviewed: true }).catch(() => undefined), 5000);
    return () => clearTimeout(t);
  }, [workspace, id]);

  if (account.error) return <ErrorState error={account.error} onRetry={() => void account.mutate()} className="rounded-md border" />;
  if (!account.data) return <LoadingState className="rounded-md border" />;
  const a = account.data;

  const sync = async () => {
    setSyncing(true);
    try {
      await syncAwsAccount(workspace, a.id);
      await refreshAws();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <Link to={awsAccountsLink(workspace)} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
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
      {error && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-300">
          {error}
          <button type="button" className="text-xs underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {a.counts.total > 0 && (
        <div className="mb-4 text-sm">
          <FunctionCounts counts={a.counts} />
        </div>
      )}
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        Pick what to trace. A CloudFormation stack is usually one app in one environment: trace it into its own project, and functions added to
        the stack later are traced too. Tag functions with <span className="font-mono">ivy:trace=false</span> or{" "}
        <span className="font-mono">ivy:project=&lt;slug&gt;</span> to decide from your infrastructure code. Moving a function to another project
        only affects new data; data already ingested stays in its project.
      </p>

      {functions.error ? (
        <ErrorState error={functions.error} onRetry={() => void functions.mutate()} className="rounded-md border" />
      ) : !functions.data ? (
        <LoadingState className="rounded-md border" />
      ) : functions.data.groups.length === 0 ? (
        <EmptyState
          title={a.syncing || a.status === "pending" ? "Scanning functions…" : "No functions found"}
          description={<>Ivy found no Lambda functions in {regionSummary(a)}.</>}
        />
      ) : (
        <FunctionPicker account={a} groups={functions.data.groups} onError={setError} />
      )}

      <EditRegionsDialog account={editing ? a : null} onOpenChange={setEditing} />
      <DeleteAccountDialog account={deleting ? a : null} onOpenChange={setDeleting} onDeleted={() => navigate(awsAccountsLink(workspace))} />
    </div>
  );
}

