import { Pause, Play } from "lucide-react";

import { RunningDot } from "@/components/common/in-progress";
import { Button } from "@/components/ui/button";
import { Tooltipped } from "@/components/ui/tooltipped";
import type { PauseReason } from "@/lib/live/live";
import { cn } from "@/lib/utils/cn";
import { formatNumber } from "@/lib/utils/format";

/** "Live" pill next to the filters: a pulsing green dot while it updates, grey while off or paused. */
export function LiveToggle({ on, paused, failing, onChange }: { on: boolean; paused: PauseReason | null; failing: boolean; onChange: (on: boolean) => void }) {
  const active = on && !paused;
  const title = !on
    ? "Show new invocations as they arrive"
    : failing
      ? "Live: the last update failed, retrying with a longer interval"
      : paused
        ? "Live is paused"
        : "Live: checking for new invocations every few seconds";
  return (
    <Tooltipped title={title}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cn(
          "inline-flex h-8 max-md:h-10 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors",
          on ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        {active ? (
          <RunningDot color={failing ? "bg-amber-400" : "bg-emerald-400"} />
        ) : (
          <span className={cn("size-2 rounded-full", on ? "bg-emerald-400/50" : "bg-muted-foreground/50")} aria-hidden />
        )}
        Live
      </button>
    </Tooltipped>
  );
}

/** Shown while live updates are paused: new rows held back (scrolled down, another page) or polling stopped (idle). */
export function LiveBanner({ paused, pending, more, onResume }: { paused: PauseReason | null; pending: number; more: boolean; onResume: () => void }) {
  if (!paused || paused === "hidden") return null;
  const idle = paused === "idle";
  return (
    <div
      className={cn(
        "sticky top-2 z-10 mb-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm shadow-sm",
        "border-emerald-400/30 bg-background/95 backdrop-blur",
      )}
      role="status"
    >
      <span className="flex items-center gap-2 text-muted-foreground">
        <Pause className="size-4 text-emerald-400" />
        {idle ? (
          "Live paused after 15 minutes without activity."
        ) : (
          <span>
            Paused
            {pending > 0 || more ? (
              <>
                , <span className="font-medium text-foreground">{more ? `${formatNumber(pending)}+` : formatNumber(pending)} new</span>
              </>
            ) : null}
          </span>
        )}
      </span>
      <Button variant="outline" size="sm" className="h-7" onClick={onResume}>
        <Play className="mr-1 size-3.5" />
        Resume
      </Button>
    </div>
  );
}
