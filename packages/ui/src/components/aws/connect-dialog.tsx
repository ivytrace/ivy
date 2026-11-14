import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { CheckCircle2, Download, ExternalLink, Loader2 } from "lucide-react";

import { RegionPicker, type RegionSelection } from "@/components/aws/region-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createAwsAccount, refreshAws, verifyAwsAccount } from "@/lib/api/aws";
import { downloadFile } from "@/lib/api/client";
import { useAwsSetup } from "@/lib/api/hooks";
import type { AwsAccount } from "@/lib/api/types";
import { accountLink } from "@/lib/links/links";

const POLL_MS = 10_000;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Connect flow: account details → deploy the stack (quick-create link, or download + upload) →
 * verify (polled while the console tab is open) → connected.
 */
export function ConnectDialog({
  open,
  onOpenChange,
  resume,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A pending account to finish setting up instead of creating a new one. */
  resume?: AwsAccount | null;
}) {
  const [account, setAccount] = useState<AwsAccount | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (open) {
      setAccount(resume ?? null);
      setConnected(false);
    }
  }, [open, resume]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {connected && account ? (
          <Connected account={account} onClose={() => onOpenChange(false)} />
        ) : account ? (
          <Deploy account={account} onConnected={(a) => (setAccount(a), setConnected(true))} />
        ) : (
          <Details onCreated={setAccount} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Details({ onCreated }: { onCreated: (account: AwsAccount) => void }) {
  const { data: setup } = useAwsSetup();
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [stackRegion, setStackRegion] = useState<string>("");
  const [selection, setSelection] = useState<RegionSelection>({ regions: [], all_regions: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const region = stackRegion || setup?.default_region || "us-east-1";
  const validId = /^\d{12}$/.test(accountId.replace(/[\s-]/g, ""));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const regions = selection.all_regions ? [] : [region, ...selection.regions.filter((r) => r !== region)];
      const account = await createAwsAccount({ account_id: accountId, name: name || undefined, stack_region: region, regions, all_regions: selection.all_regions });
      await refreshAws();
      onCreated(account);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Connect an AWS account</DialogTitle>
        <DialogDescription>
          You'll deploy a small CloudFormation stack that lets Ivy attach its tracing layer to your Node.js functions.
        </DialogDescription>
      </DialogHeader>
      {setup?.issues.length ? <SetupIssues issues={setup.issues} /> : null}
      <Field label="AWS account ID" htmlFor="account-id">
        <Input
          id="account-id"
          inputMode="numeric"
          placeholder="123456789012"
          autoFocus
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="h-9 font-mono"
        />
      </Field>
      <Field label="Name" htmlFor="account-name" hint="Optional, e.g. Production">
        <Input id="account-name" value={name} onChange={(e) => setName(e.target.value)} className="h-9" placeholder={`AWS ${accountId || "account"}`} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Stack region">
          <Select value={region} onValueChange={setStackRegion}>
            <SelectTrigger className="h-9 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {(setup?.regions ?? [region]).map((r) => (
                <SelectItem key={r} value={r} className="font-mono">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Regions to trace">
          <RegionPicker value={selection} onChange={setSelection} options={setup?.regions ?? []} locked={region} />
        </Field>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <DialogFooter>
        <Button type="submit" disabled={!validId || busy}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          Continue
        </Button>
      </DialogFooter>
    </form>
  );
}

function Deploy({ account, onConnected }: { account: AwsAccount; onConnected: (account: AwsAccount) => void }) {
  const [polling, setPolling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  async function verify() {
    setChecking(true);
    try {
      const res = await verifyAwsAccount(account.id);
      if (res.verified) {
        clearInterval(timer.current);
        await refreshAws();
        onConnected(res.account);
      } else {
        setLastError(res.account.error);
      }
    } catch (err) {
      setLastError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  function startPolling() {
    if (polling) return;
    setPolling(true);
    clearInterval(timer.current);
    timer.current = setInterval(() => void verify(), POLL_MS);
  }

  useEffect(() => () => clearInterval(timer.current), []);

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Deploy the Ivy stack</DialogTitle>
        <DialogDescription>
          Account <span className="font-mono">{account.account_id}</span>, region{" "}
          <span className="font-mono">{account.stack_region}</span>. Sign in to that account first.
        </DialogDescription>
      </DialogHeader>

      {account.quick_create_url ? (
        <ol className="grid gap-3 text-sm">
          <Step n={1}>
            <Button asChild onClick={startPolling}>
              <a href={account.quick_create_url} target="_blank" rel="noreferrer">
                Open in AWS CloudFormation
                <ExternalLink className="ml-2 size-4" />
              </a>
            </Button>
          </Step>
          <Step n={2}>
            At the bottom of the page, tick <em>"I acknowledge that AWS CloudFormation might create IAM resources with custom names"</em> and
            click <strong>Create stack</strong>. It takes about a minute.
          </Step>
        </ol>
      ) : (
        <ol className="grid gap-3 text-sm">
          <Step n={1}>
            <Button
              variant="outline"
              onClick={() => {
                startPolling();
                void downloadFile(account.template_download_url, `ivy-trace-${account.id.slice(0, 8)}.yaml`);
              }}
            >
              <Download className="mr-2 size-4" />
              Download template
            </Button>
          </Step>
          <Step n={2}>
            Open{" "}
            <a
              className="text-primary hover:underline"
              href={`https://${account.stack_region}.console.aws.amazon.com/cloudformation/home?region=${account.stack_region}#/stacks/create`}
              target="_blank"
              rel="noreferrer"
            >
              CloudFormation → Create stack
            </a>
            , choose <em>Upload a template file</em> and pick the downloaded file. Name the stack{" "}
            <span className="font-mono">{account.stack_name}</span> and keep the parameters as they are.
          </Step>
          <Step n={3}>
            Tick the IAM acknowledgement and click <strong>Create stack</strong>.
          </Step>
          <p className="text-xs text-muted-foreground">
            No template URL is configured on this server (<span className="font-mono">IVY_CFN_TEMPLATE_URL</span>), so there's no one-click link.
          </p>
        </ol>
      )}

      <details className="rounded-md border px-3 py-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Stack details</summary>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 font-mono">
          <dt className="font-sans text-muted-foreground">Role</dt>
          <dd className="break-all">{account.role_arn}</dd>
          <dt className="font-sans text-muted-foreground">External ID</dt>
          <dd className="break-all">{account.external_id}</dd>
          <dt className="font-sans text-muted-foreground">Stack name</dt>
          <dd>{account.stack_name}</dd>
        </dl>
      </details>

      <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {polling || checking ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        <span className="text-muted-foreground">
          {polling ? "Waiting for the stack… Ivy checks every 10 seconds." : "Once the stack is created, verify the connection."}
          {lastError && polling && <span className="mt-1 block truncate text-xs" title={lastError}>{lastError}</span>}
        </span>
      </div>

      <DialogFooter>
        <Button onClick={() => (startPolling(), void verify())} disabled={checking}>
          I've deployed it, verify
        </Button>
      </DialogFooter>
    </div>
  );
}

function Connected({ account, onClose }: { account: AwsAccount; onClose: () => void }) {
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-emerald-400" />
          Connected
        </DialogTitle>
        <DialogDescription>
          Ivy is attaching its layer to the Node.js functions in {account.name}. Traces appear after each function's next
          invocation.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button asChild onClick={onClose}>
          <Link to={accountLink(account.id)}>View functions</Link>
        </Button>
      </DialogFooter>
    </div>
  );
}

export function SetupIssues({ issues }: { issues: string[] }) {
  return (
    <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-300">
      <div className="font-medium">Server setup incomplete</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground">{n}</span>
      <div className="pt-0.5">{children}</div>
    </li>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {hint && <span className="ml-2 font-normal text-muted-foreground">{hint}</span>}
      </Label>
      {children}
    </div>
  );
}
