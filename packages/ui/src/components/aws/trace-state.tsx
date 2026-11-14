import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Tooltipped } from "@/components/ui/tooltipped";
import { refreshAws, setFunctionTracing } from "@/lib/api/aws";
import type { AwsFunction, TraceState } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

export const TRACE_STATE_LABELS: Record<TraceState, string> = {
  traced: "Traced",
  opted_out: "Opted out",
  unsupported: "Unsupported",
  conflict: "Conflict",
  error: "Error",
  pending: "Pending",
};

const DOT: Record<TraceState, string> = {
  traced: "bg-emerald-400",
  opted_out: "bg-muted-foreground",
  unsupported: "bg-muted-foreground/40",
  conflict: "bg-amber-400",
  error: "bg-red-400",
  pending: "bg-sky-400",
};

const TEXT: Record<TraceState, string> = {
  traced: "text-emerald-400",
  opted_out: "text-muted-foreground",
  unsupported: "text-muted-foreground",
  conflict: "text-amber-400",
  error: "text-red-400",
  pending: "text-sky-400",
};

export function StateDot({ state, className }: { state: TraceState; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[state], className)} />;
}

export function TraceStateLabel({ state, reason }: { state: TraceState; reason?: string | null }) {
  const label = (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-sm", TEXT[state])}>
      <StateDot state={state} />
      {TRACE_STATE_LABELS[state]}
    </span>
  );
  return reason ? <Tooltipped title={<span className="block max-w-sm">{reason}</span>}>{label}</Tooltipped> : label;
}

/** Opted out by the `ivy:trace=false` tag (the dashboard setting is still on): only the tag can change it. */
const optedOutByTag = (fn: AwsFunction) => fn.state === "opted_out" && fn.tracing_enabled;

/** Can tracing be turned on/off for this function from the dashboard? */
export const isToggleable = (fn: AwsFunction) => fn.state !== "unsupported" && !optedOutByTag(fn);

export function TracingToggle({ fn, onError }: { fn: AwsFunction; onError?: (message: string) => void }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? (isToggleable(fn) && fn.tracing_enabled);

  async function setEnabled(enabled: boolean) {
    setPending(enabled);
    try {
      const res = await setFunctionTracing(fn.account_id, fn.region, fn.name, enabled);
      if (!res.applied && res.error) onError?.(`${fn.name}: ${res.error}`);
    } catch (err) {
      onError?.(`${fn.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refreshAws();
      setPending(null);
    }
  }

  const control = (
    <span className="inline-flex items-center gap-2">
      <Switch
        checked={checked}
        disabled={!isToggleable(fn) || pending !== null}
        onCheckedChange={(v) => void setEnabled(v)}
        aria-label={`Trace ${fn.name}`}
      />
      {pending !== null && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
    </span>
  );
  if (isToggleable(fn)) return control;
  return <Tooltipped title={fn.reason ?? "Can't be traced"}>{control}</Tooltipped>;
}
