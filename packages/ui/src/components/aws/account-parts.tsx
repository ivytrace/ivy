import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";

import { RegionPicker, type RegionSelection } from "@/components/aws/region-picker";
import { StateDot, TRACE_STATE_LABELS } from "@/components/aws/trace-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { deleteAwsAccount, refreshAws, updateAwsAccount } from "@/lib/api/aws";
import { downloadFile } from "@/lib/api/client";
import { useAwsSetup } from "@/lib/api/hooks";
import type { AwsAccount, TraceState } from "@/lib/api/types";
import { useWorkspace } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";

export function AccountStatus({ account }: { account: AwsAccount }) {
  if (account.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-sky-400">
        <Clock className="size-4" />
        Waiting for stack
      </span>
    );
  }
  if (account.status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-red-400">
        <AlertTriangle className="size-4" />
        Can't connect
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", account.error ? "text-amber-400" : "text-emerald-400")}>
      {account.syncing ? <Loader2 className="size-4 animate-spin" /> : account.error ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
      {account.syncing ? "Syncing" : account.error ? "Connected, with errors" : "Connected"}
    </span>
  );
}

const COUNT_ORDER: TraceState[] = ["traced", "needs_project", "available", "opted_out", "conflict", "error", "pending", "unsupported"];

/** Compact per-state function counts; zero counts are left out (except traced). */
export function FunctionCounts({ counts, onSelect }: { counts: AwsAccount["counts"]; onSelect?: (state: TraceState) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {counts.new > 0 && <NewBadge count={counts.new} />}
      {COUNT_ORDER.filter((s) => s === "traced" || counts[s] > 0).map((state) => {
        const content = (
          <>
            <StateDot state={state} />
            <span className="tabular-nums">{counts[state]}</span>
            <span className="text-muted-foreground">{TRACE_STATE_LABELS[state].toLowerCase()}</span>
          </>
        );
        return onSelect ? (
          <button key={state} type="button" onClick={() => onSelect(state)} className="inline-flex items-center gap-1.5 hover:underline">
            {content}
          </button>
        ) : (
          <span key={state} className="inline-flex items-center gap-1.5">
            {content}
          </span>
        );
      })}
    </span>
  );
}

export function EditRegionsDialog({ account, onOpenChange }: { account: AwsAccount | null; onOpenChange: (open: boolean) => void }) {
  const workspace = useWorkspace();
  const { data: setup } = useAwsSetup();
  const [value, setValue] = useState<RegionSelection>({ regions: [], all_regions: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (account) setValue({ regions: account.regions, all_regions: account.all_regions });
    setError(null);
  }, [account]);

  async function save() {
    if (!account) return;
    setBusy(true);
    try {
      const regions = value.all_regions ? value.regions : [...new Set([account.stack_region, ...value.regions])];
      await updateAwsAccount(workspace, account.id, { regions, all_regions: value.all_regions });
      await refreshAws();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regions</DialogTitle>
          <DialogDescription>Ivy scans these regions of {account?.name} for Node.js functions.</DialogDescription>
        </DialogHeader>
        <RegionPicker value={value} onChange={setValue} options={setup?.regions ?? []} locked={account?.stack_region} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <DialogFooter>
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save and sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAccountDialog({
  account,
  onOpenChange,
  onDeleted,
}: {
  account: AwsAccount | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const workspace = useWorkspace();
  const [detach, setDetach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    setDetach(true);
    setErrors([]);
  }, [account]);

  async function remove() {
    if (!account) return;
    setBusy(true);
    try {
      const res = await deleteAwsAccount(workspace, account.id, detach && account.status !== "pending");
      await refreshAws();
      if (res.detach_errors.length) setErrors(res.detach_errors);
      else {
        onOpenChange(false);
        onDeleted?.();
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {account?.name}?</DialogTitle>
          <DialogDescription>
            Ivy stops managing this account. Afterwards, delete the CloudFormation stack{" "}
            <span className="font-mono">{account?.stack_name}</span> in <span className="font-mono">{account?.stack_region}</span>{" "}
            to remove the role.
          </DialogDescription>
        </DialogHeader>
        {account?.status !== "pending" && (
          <div className="flex items-center gap-2">
            <Switch id="detach" checked={detach} onCheckedChange={setDetach} />
            <Label htmlFor="detach" className="font-normal">
              Remove the Ivy layer and variables from all functions first
            </Label>
          </div>
        )}
        {errors.length > 0 && (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
            Disconnected, but some functions could not be cleaned up:
            <ul className="mt-1 list-disc pl-4">
              {errors.slice(0, 8).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          {errors.length ? (
            <Button variant="outline" onClick={() => (onOpenChange(false), onDeleted?.())}>
              Close
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              Disconnect
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Per-account switch for CloudWatch throttle polling, plus the hint when the stack predates the permission. */
export function ThrottleSetting({ account }: { account: AwsAccount }) {
  const workspace = useWorkspace();
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checked = pending ?? account.throttle_metrics;

  async function toggle(enabled: boolean) {
    setPending(enabled);
    setError(null);
    try {
      await updateAwsAccount(workspace, account.id, { throttle_metrics: enabled });
      await refreshAws();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mb-4 rounded-md border px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <Switch
          id={`throttles-${account.id}`}
          checked={checked}
          disabled={pending !== null}
          onCheckedChange={(v) => void toggle(v)}
          className="mt-0.5"
        />
        <div>
          <Label htmlFor={`throttles-${account.id}`} className="font-medium">
            Throttle metrics
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every 5 minutes Ivy reads the Lambda <span className="font-mono">Throttles</span> metric from CloudWatch in the
            regions with traced functions, so throttled requests (which never reach a function) show up as errors.
            CloudWatch bills <span className="font-mono">GetMetricData</span> to this AWS account: about $0.09 per region per
            month, plus a little more while functions are being throttled.
          </p>
        </div>
      </div>
      {account.throttle_metrics && account.throttle_status === "missing_permission" && (
        <div className="mt-3 flex items-start gap-2 rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The role in stack <span className="font-mono">{account.stack_name}</span> can&apos;t read CloudWatch metrics yet
            (it predates <span className="font-mono">cloudwatch:GetMetricData</span>). Update the stack with the{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void downloadFile(account.template_download_url, `ivy-trace-${account.id.slice(0, 8)}.yaml`)}
            >
              current template
            </button>{" "}
            (CloudFormation → {account.stack_name} → Update → Replace existing template) to see throttles. Tracing is not
            affected.
          </span>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** "N new": functions found since the list was last looked at, not traced yet. */
export function NewBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full bg-sky-400/15 px-2 py-0.5 text-xs font-medium tabular-nums text-sky-300", className)}>
      {count} new
    </span>
  );
}
