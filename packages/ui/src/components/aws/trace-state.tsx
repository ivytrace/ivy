import { useState } from "react";
import { Ban, Check, ListFilter, Loader2, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltipped } from "@/components/ui/tooltipped";
import { refreshAws, setFunctionChoice, type ManualChoice } from "@/lib/api/aws";
import { useProjects } from "@/lib/api/hooks";
import type { AwsFunction, TraceState } from "@/lib/api/types";
import { useWorkspace } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";

export const TRACE_STATE_LABELS: Record<TraceState, string> = {
  traced: "Traced",
  available: "Available",
  opted_out: "Excluded",
  unsupported: "Unsupported",
  conflict: "Conflict",
  error: "Error",
  pending: "Pending",
};

const DOT: Record<TraceState, string> = {
  traced: "bg-emerald-400",
  available: "border border-muted-foreground bg-transparent",
  opted_out: "bg-muted-foreground",
  unsupported: "bg-muted-foreground/40",
  conflict: "bg-amber-400",
  error: "bg-red-400",
  pending: "bg-sky-400",
};

const TEXT: Record<TraceState, string> = {
  traced: "text-emerald-400",
  available: "text-muted-foreground",
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

const SOURCE_LABELS = { tag: "tag", manual: "manual", rule: "rule" } as const;

/** Where a function sends spans and what decided it: `checkout-prod · rule`. */
export function FunctionProject({ fn }: { fn: AwsFunction }) {
  if (!fn.project && !fn.source) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      {fn.project && <span className="font-mono">{fn.project}</span>}
      {fn.source && <span className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{SOURCE_LABELS[fn.source]}</span>}
    </span>
  );
}

const traceable = (fn: AwsFunction) => !["unsupported"].includes(fn.state);

/** Per-function manual choice: trace into a project, exclude, or follow the rules again. */
export function FunctionChoiceMenu({ fn, onError }: { fn: AwsFunction; onError?: (message: string) => void }) {
  const workspace = useWorkspace();
  const projects = useProjects(workspace);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function choose(choice: ManualChoice) {
    setOpen(false);
    setBusy(true);
    try {
      const res = await setFunctionChoice(workspace, fn, choice);
      if (!res.applied && res.error) onError?.(`${fn.name}: ${res.error}`);
    } catch (err) {
      onError?.(`${fn.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refreshAws();
      setBusy(false);
    }
  }

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" disabled={busy || !traceable(fn)} aria-label={`Tracing of ${fn.name}`}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Trace into</div>
        <div className="max-h-56 overflow-y-auto">
          {projects.data?.items.map((p) => {
            const current = fn.manual?.mode === "trace" && fn.manual.project === p.slug;
            return (
              <button key={p.id} type="button" className={item} onClick={() => void choose({ mode: "trace", project: p.slug })}>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {current && <Check className="size-4" />}
              </button>
            );
          })}
        </div>
        <div className="-mx-1 my-1 border-t" />
        <button type="button" className={item} onClick={() => void choose({ mode: "exclude" })}>
          <Ban className="size-4" />
          <span className="flex-1">Exclude</span>
          {fn.manual?.mode === "exclude" && <Check className="size-4" />}
        </button>
        <button type="button" className={item} onClick={() => void choose({ mode: "rules" })} disabled={!fn.manual}>
          <ListFilter className="size-4" />
          <span className="flex-1">Follow tags and rules</span>
          {!fn.manual && <Check className="size-4" />}
        </button>
        <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">
          Moving a function to another project only affects new data; data already ingested stays in its project.
        </p>
      </PopoverContent>
    </Popover>
  );
}
