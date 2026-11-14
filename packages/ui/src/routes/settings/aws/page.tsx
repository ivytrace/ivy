import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Cloud, MapPin, Plus, RefreshCw, Trash2 } from "lucide-react";

import { AccountStatus, DeleteAccountDialog, EditRegionsDialog, FunctionCounts } from "@/components/aws/account-parts";
import { ConnectDialog, SetupIssues } from "@/components/aws/connect-dialog";
import { regionSummary } from "@/components/aws/region-picker";
import { ErrorState, LoadingState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Tooltipped } from "@/components/ui/tooltipped";
import { refreshAws, syncAwsAccount } from "@/lib/api/aws";
import { useAwsAccounts, useAwsSetup } from "@/lib/api/hooks";
import type { AwsAccount } from "@/lib/api/types";
import { accountLink } from "@/lib/links/links";
import { formatAgo } from "@/lib/utils/format";

export default function AwsAccounts() {
  const accounts = useAwsAccounts();
  const { data: setup } = useAwsSetup();
  const [connectOpen, setConnectOpen] = useState(false);
  const [resume, setResume] = useState<AwsAccount | null>(null);
  const [editing, setEditing] = useState<AwsAccount | null>(null);
  const [deleting, setDeleting] = useState<AwsAccount | null>(null);

  const [params, setParams] = useSearchParams();

  const connect = (account: AwsAccount | null = null) => {
    setResume(account);
    setConnectOpen(true);
  };

  useEffect(() => {
    if (params.get("connect")) {
      connect();
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">AWS accounts</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Ivy assumes a role in each connected account to attach its tracing layer to every Node.js function, including new
            ones. Turn tracing off for single functions on the account's page.
          </p>
        </div>
        <Button onClick={() => connect()}>
          <Plus className="mr-2 size-4" />
          Connect AWS account
        </Button>
      </div>

      {setup?.issues.length ? (
        <div className="mb-6">
          <SetupIssues issues={setup.issues} />
        </div>
      ) : null}

      {accounts.error ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.mutate()} className="rounded-md border" />
      ) : !accounts.data ? (
        <LoadingState className="rounded-md border" />
      ) : accounts.data.items.length === 0 ? (
        <NoAccounts onConnect={() => connect()} />
      ) : (
        <div className="grid gap-3">
          {accounts.data.items.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onResume={() => connect(account)}
              onEdit={() => setEditing(account)}
              onDelete={() => setDeleting(account)}
            />
          ))}
        </div>
      )}

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} resume={resume} />
      <EditRegionsDialog account={editing} onOpenChange={(open) => !open && setEditing(null)} />
      <DeleteAccountDialog account={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}

export function NoAccounts({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-10 text-center">
      <Cloud className="size-8 text-muted-foreground" />
      <div>
        <div className="font-medium">No AWS accounts connected</div>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Connecting takes a couple of minutes: deploy one CloudFormation stack, and Ivy takes care of the rest.
        </p>
      </div>
      <Button onClick={onConnect}>
        <Plus className="mr-2 size-4" />
        Connect AWS account
      </Button>
    </div>
  );
}

function AccountCard({
  account,
  onResume,
  onEdit,
  onDelete,
}: {
  account: AwsAccount;
  onResume: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      await syncAwsAccount(account.id);
      await refreshAws();
    } finally {
      setSyncing(false);
    }
  };
  const pending = account.status === "pending";

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <div className="min-w-48">
          {pending ? (
            <span className="font-semibold">{account.name}</span>
          ) : (
            <Link to={accountLink(account.id)} className="font-semibold text-primary hover:underline">
              {account.name}
            </Link>
          )}
          <div className="font-mono text-xs text-muted-foreground">{account.account_id}</div>
        </div>
        <div className="min-w-40">
          <AccountStatus account={account} />
          <div className="text-xs text-muted-foreground">
            {account.last_sync_at ? `Synced ${formatAgo(account.last_sync_at)}` : pending ? "Deploy the stack to finish" : "Not synced yet"}
          </div>
        </div>
        <div className="min-w-40">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <MapPin className="size-3.5 text-muted-foreground" />
            {regionSummary(account)}
          </span>
          <div className="text-xs text-muted-foreground">Stack in {account.stack_region}</div>
        </div>
        {!pending && (
          <div className="min-w-56 flex-1">
            <FunctionCounts counts={account.counts} />
            <div className="text-xs text-muted-foreground">{account.counts.total} functions</div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {pending ? (
            <Button size="sm" onClick={onResume}>
              Finish setup
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" asChild>
                <Link to={accountLink(account.id)}>Functions</Link>
              </Button>
              <Tooltipped title="Sync now">
                <Button size="icon" variant="ghost" onClick={() => void sync()} disabled={syncing || account.syncing} aria-label="Sync now">
                  <RefreshCw className={syncing || account.syncing ? "size-4 animate-spin" : "size-4"} />
                </Button>
              </Tooltipped>
              <Tooltipped title="Regions">
                <Button size="icon" variant="ghost" onClick={onEdit} aria-label="Edit regions">
                  <MapPin className="size-4" />
                </Button>
              </Tooltipped>
            </>
          )}
          <Tooltipped title="Disconnect">
            <Button size="icon" variant="ghost" onClick={onDelete} aria-label="Disconnect">
              <Trash2 className="size-4" />
            </Button>
          </Tooltipped>
        </div>
      </div>
      {account.error && (
        <pre className="mt-3 whitespace-pre-wrap break-words rounded bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          {account.error}
        </pre>
      )}
    </div>
  );
}
