import { useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, CreditCard, Loader2, OctagonX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { billingSessionUrl, type BillingAction } from "@/lib/api/billing";
import type { Usage } from "@/lib/api/types";
import { USAGE_PATH } from "@/lib/links/links";
import { barPercent, usageState, type UsageLevel } from "@/lib/usage/state";
import { cn } from "@/lib/utils/cn";

const BAR_COLOUR: Record<UsageLevel, string> = {
  unlimited: "bg-emerald-500",
  ok: "bg-emerald-500",
  included: "bg-emerald-500",
  warning: "bg-amber-400",
  blocked: "bg-red-500",
  overage: "bg-sky-500",
};

export const formatCount = (n: number) => n.toLocaleString("en-US");

export function UsageBar({ usage }: { usage: Usage }) {
  const state = usageState(usage);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(barPercent(state.ratio))}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={cn("h-full rounded-full transition-all", BAR_COLOUR[state.level])} style={{ width: `${barPercent(state.ratio)}%` }} />
    </div>
  );
}

/** The quota message shown dashboard-wide (and on the usage page) at 80% and at 100%. */
export function QuotaNotice({ usage, compact = false }: { usage: Usage; compact?: boolean }) {
  const { banner, ratio } = usageState(usage);
  if (!banner) return null;
  const quota = formatCount(usage.limits.monthly_trace_quota ?? 0);
  const blocked = banner === "blocked";
  const Icon = blocked ? OctagonX : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-center gap-2 text-xs",
        compact ? "border-b px-4 py-1" : "rounded-md border px-3 py-2",
        blocked ? "border-red-500/20 bg-red-500/10 text-red-300" : "border-amber-500/20 bg-amber-500/10 text-amber-300",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>
        {blocked
          ? `Monthly trace quota reached (${quota}). New traces are rejected until the month ends.`
          : `${Math.floor((ratio ?? 0) * 100)}% of this month's ${quota} traces used.`}{" "}
        {compact && (
          <Link to={USAGE_PATH} className="underline underline-offset-2 hover:text-foreground">
            {blocked ? "Upgrade" : "See usage"}
          </Link>
        )}
      </span>
    </div>
  );
}

/** "Upgrade" (Stripe Checkout) or "Manage billing" (Customer Portal) through the hosted billing service. */
export function BillingButton({ billingUrl, usage }: { billingUrl: string; usage: Usage }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paid = usage.limits.source === "workspace" && usage.limits.over_quota === "allow";
  const action: BillingAction = paid ? "portal" : "checkout";

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await billingSessionUrl(billingUrl, action, usage.workspace));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button onClick={() => void go()} disabled={busy} variant={paid ? "outline" : "default"}>
        {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CreditCard className="mr-2 size-4" />}
        {paid ? "Manage billing" : "Upgrade"}
      </Button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
