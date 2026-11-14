import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { CheckCircle2 } from "lucide-react";

import { ErrorState, LoadingState } from "@/components/common/states";
import { BillingButton, formatCount, QuotaNotice, UsageBar } from "@/components/usage/usage-parts";
import { useConfig, useUsage, useWorkspaceInfo } from "@/lib/api/hooks";
import type { Usage } from "@/lib/api/types";
import { useWorkspace } from "@/lib/links/use-scope";
import { billingAction, usageState } from "@/lib/usage/state";
import { format } from "date-fns";

export default function UsagePage() {
  const workspace = useWorkspace();
  const usage = useUsage(workspace);
  const { data: config } = useConfig();
  const role = useWorkspaceInfo(workspace).data?.role;
  const [params] = useSearchParams();
  const checkout = params.get("checkout");

  // Back from checkout: the plan changes once the billing service has updated the limits, usually within seconds.
  useEffect(() => {
    if (checkout !== "success") return;
    const timers = [3_000, 8_000, 20_000].map((ms) => setTimeout(() => void usage.mutate(), ms));
    return () => timers.forEach(clearTimeout);
  }, [checkout]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Usage</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Ivy counts one trace per Lambda invocation, across all of this workspace's projects. Usage resets on the first
          day of each month (UTC).
        </p>
      </div>

      {checkout === "success" && (
        <div className="mb-4 flex max-w-3xl items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <CheckCircle2 className="size-4" />
          Thanks! Your plan updates here within a few seconds.
        </div>
      )}

      {usage.error ? (
        <ErrorState error={usage.error} onRetry={() => void usage.mutate()} className="rounded-md border" />
      ) : !usage.data ? (
        <LoadingState className="rounded-md border" />
      ) : (
        <UsageCard usage={usage.data} billingUrl={config?.billing?.url} role={role} />
      )}
    </div>
  );
}

function UsageCard({ usage, billingUrl, role }: { usage: Usage; billingUrl?: string; role?: "owner" | "member" }) {
  const action = billingAction(usage, role);
  const state = usageState(usage);
  const quota = usage.limits.monthly_trace_quota;
  const plan = usage.limits.plan || (quota === null ? "Unlimited" : "Custom");
  const month = format(new Date(usage.period.start), "MMMM yyyy");

  return (
    <div className="grid max-w-3xl gap-4">
      <QuotaNotice usage={usage} />
      <div className="rounded-md border p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Plan</div>
            <div className="mt-1 text-lg font-semibold">{plan}</div>
          </div>
          {billingUrl &&
            (action ? (
              <BillingButton billingUrl={billingUrl} usage={usage} action={action} />
            ) : role === "member" ? (
              <p className="max-w-56 text-right text-xs text-muted-foreground">Only workspace owners can change billing.</p>
            ) : null)}
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm">
              <span className="text-2xl font-semibold tabular-nums">{formatCount(usage.traces)}</span>{" "}
              <span className="text-muted-foreground">traces in {month}</span>
            </div>
            <div className="text-sm text-muted-foreground tabular-nums">
              {quota === null ? "Unlimited" : `of ${formatCount(quota)}${usage.limits.over_quota === "allow" ? " included" : ""}`}
            </div>
          </div>
          {quota !== null && (
            <div className="mt-3">
              <UsageBar usage={usage} />
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{explain(state.level, usage)}</p>
        </div>
      </div>
    </div>
  );
}

function explain(level: ReturnType<typeof usageState>["level"], usage: Usage): string {
  const quota = formatCount(usage.limits.monthly_trace_quota ?? 0);
  switch (level) {
    case "unlimited":
      return "This workspace has no trace quota.";
    case "ok":
    case "warning":
      return `Ingest stops accepting new traces at ${quota} this month.`;
    case "blocked":
      return "New traces are rejected until the month ends. Upgrade to keep ingesting.";
    case "included":
      return `Traces beyond the ${quota} included this month keep being accepted and are billed.`;
    case "overage":
      return `Over the ${quota} included traces: the rest of this month is billed.`;
  }
}
