import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Loader2 } from "lucide-react";

import { StateDot, TRACE_STATE_LABELS, TraceStateLabel } from "@/components/aws/trace-state";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { refreshAws, setFunctionForce } from "@/lib/api/aws";
import type { AwsFunction } from "@/lib/api/types";
import { useWorkspace } from "@/lib/links/use-scope";

const CLOSE_DELAY_MS = 150;

type Forceable = Pick<AwsFunction, "tracer" | "wrapper">;

const Wrapper = ({ value }: { value: string | null }) => <span className="font-mono">{value ?? "its wrapper"}</span>;

/** What a force install does to the other tracer, shown before the user confirms. */
export function ForceInstallNotice({ fn }: { fn: Forceable }) {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p className="text-sm font-medium text-foreground">Replace {fn.tracer ? `${fn.tracer}'s` : "the other"} wrapper?</p>
      <p className="text-amber-300">{fn.tracer ?? "The other tracer"} will most likely stop tracing this function.</p>
      <p>
        Ivy sets <span className="font-mono">AWS_LAMBDA_EXEC_WRAPPER</span> to its own wrapper and adds its layer. The other
        tracer's layer and variables stay. Ivy restores <Wrapper value={fn.wrapper} /> if you stop tracing the function
        here or disconnect the account.
      </p>
    </div>
  );
}

/** Why the function is in conflict, and what a force install can do about it. */
export function ConflictSummary({ fn }: { fn: Pick<AwsFunction, "tracer" | "wrapper" | "conflict" | "reason"> }) {
  const tracer = fn.tracer ? ` (${fn.tracer})` : "";
  if (fn.conflict === "reapplied") {
    return (
      <div className="grid gap-2 text-xs text-muted-foreground">
        <p className="text-sm text-foreground">
          <span className="font-mono">AWS_LAMBDA_EXEC_WRAPPER</span> was set back to <Wrapper value={fn.wrapper} />
          {tracer} after Ivy replaced it.
        </p>
        <p>
          Something, usually {fn.tracer ? `${fn.tracer}'s` : "the other tracer's"} own integration, keeps re-applying it, so Ivy
          stopped replacing it instead of overwriting it on every sync. Turn that off for this function, then try again.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p className="text-sm text-foreground">
        <span className="font-mono">AWS_LAMBDA_EXEC_WRAPPER</span> is already set to <Wrapper value={fn.wrapper} />
        {tracer}.
      </p>
      <p>Ivy can replace it with its own wrapper.</p>
    </div>
  );
}

/**
 * The "Conflict" label of a function another tracer's exec wrapper is in the way of. Opens on hover (and
 * stays open while the pointer is over it) or on click/Enter, with a "Force install" button and a
 * confirmation step.
 */
export function ConflictState({ fn, onError }: { fn: AwsFunction; onError?: (message: string) => void }) {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const byHover = useRef(false);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const sticky = confirming || busy;
  const enter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(closeTimer.current);
    if (!open) {
      byHover.current = true;
      setOpen(true);
    }
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || sticky || !byHover.current) return;
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const change = (next: boolean) => {
    window.clearTimeout(closeTimer.current);
    if (!next && busy) return;
    byHover.current = false;
    setOpen(next);
    if (!next) setConfirming(false);
  };

  async function force() {
    setBusy(true);
    try {
      const res = await setFunctionForce(workspace, fn, true);
      if (!res.applied && res.error) onError?.(`${fn.name}: ${res.error}`);
    } catch (err) {
      onError?.(`${fn.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refreshAws();
      setBusy(false);
      setConfirming(false);
      setOpen(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={(e) => {
            // A click on a label that hover opened keeps it open (and pins it) instead of toggling it shut.
            if (open && byHover.current) {
              e.preventDefault();
              byHover.current = false;
            }
          }}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm text-sm text-amber-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`Conflict: ${fn.reason ?? "another tracer is in the way"}`}
        >
          <StateDot state="conflict" />
          {TRACE_STATE_LABELS.conflict}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onPointerEnter={enter}
        onPointerLeave={leave}
        onOpenAutoFocus={(e) => {
          if (byHover.current) e.preventDefault();
        }}
      >
        {confirming ? (
          <div className="grid gap-3">
            <ForceInstallNotice fn={fn} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void force()} disabled={busy}>
                {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                Force install
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <ConflictSummary fn={fn} />
            <div>
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                {fn.conflict === "reapplied" ? "Force install again" : "Force install"}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The reason shown for a traced function whose exec wrapper Ivy replaced (force install). */
export function forcedReason(fn: Forceable): string {
  const owner = fn.tracer ? `${fn.tracer}'s wrapper` : "another tracer's wrapper";
  return `Force-installed: ${owner} (${fn.wrapper}) was replaced. Ivy restores it when it stops tracing this function.`;
}

/** A function's tracing state; a conflict over another tracer's exec wrapper offers a force install. */
export function FunctionState({ fn, onError }: { fn: AwsFunction; onError?: (message: string) => void }) {
  if (fn.state === "conflict" && (fn.conflict === "wrapper" || fn.conflict === "reapplied")) return <ConflictState fn={fn} onError={onError} />;
  if (fn.state === "traced" && fn.wrapper) return <TraceStateLabel state="traced" reason={forcedReason(fn)} />;
  return <TraceStateLabel state={fn.state} reason={fn.reason} />;
}
