import { CheckCircle2, CircleX, Hourglass, MemoryStick, PowerOff, SnowflakeIcon, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltipped } from "@/components/ui/tooltipped";
import { failureLabel, type FailureKind } from "@/lib/spans/services";

export function HttpStatusBadge({ status }: { status: number | string }) {
  const s = String(status);
  const variant = s.startsWith("2") || s.startsWith("3") ? "success" : s.startsWith("4") ? "warning" : s.startsWith("5") ? "error" : "outline";
  return (
    <Tooltipped title={`HTTP status ${s}`}>
      <Badge variant={variant} className="px-1.5 py-0 font-mono">
        {s}
      </Badge>
    </Tooltipped>
  );
}

const FAILURE_ICONS = { init_failed: PowerOff, out_of_memory: MemoryStick, timed_out: Hourglass, crashed: Zap };
const FAILURE_HINTS: Record<FailureKind, string> = {
  init_failed: "The function failed while loading, before the handler ran. Reported by the Ivy extension from the Lambda platform.",
  out_of_memory: "The process ran out of memory and was stopped by Lambda.",
  timed_out: "The invocation reached the function timeout and was stopped by Lambda.",
  crashed: "The runtime process exited during the invocation.",
};

/** Label for failures outside the handler: Init failed, Out of memory, Timed out, Crashed. */
export function FailureBadge({ kind, hint = true }: { kind: FailureKind; hint?: boolean }) {
  const Icon = FAILURE_ICONS[kind];
  const badge = (
    <Badge variant="error" className="shrink-0 gap-1 whitespace-nowrap px-1.5 py-0">
      <Icon className="size-3" />
      {failureLabel(kind)}
    </Badge>
  );
  return hint ? <Tooltipped title={<span className="block max-w-xs">{FAILURE_HINTS[kind]}</span>}>{badge}</Tooltipped> : badge;
}

export function InvocationStatus({
  ok,
  errorType,
  errorMessage,
  httpStatus,
  failureKind,
}: {
  ok: boolean;
  errorType?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | string | null;
  failureKind?: FailureKind | null;
}) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-2 text-emerald-400">
        <CheckCircle2 className="size-4" />
        Successful
        {httpStatus ? <HttpStatusBadge status={httpStatus} /> : null}
      </span>
    );
  }
  return (
    <Tooltipped title={<span className="block max-w-md">{errorMessage || "Invocation failed"}</span>}>
      <span className="inline-flex max-w-xs items-center gap-2 text-red-400">
        <CircleX className="size-4 shrink-0" />
        {failureKind && <FailureBadge kind={failureKind} hint={false} />}
        <span className="truncate">{errorType || "Invocation failed"}</span>
        {httpStatus ? <HttpStatusBadge status={httpStatus} /> : null}
      </span>
    </Tooltipped>
  );
}

export function ColdStart() {
  return (
    <Tooltipped title="Cold start">
      <SnowflakeIcon className="size-3.5 text-sky-400" aria-label="Cold start" />
    </Tooltipped>
  );
}

/** Memory used against the limit, e.g. `84 / 128 MB`, red when the limit was reached. */
export function MemoryUsage({ used, limit }: { used: number; limit: number | null }) {
  const full = limit !== null && used >= limit;
  return (
    <span className={full ? "text-red-400" : undefined}>
      {used}
      {limit !== null && <span className="font-normal text-muted-foreground"> / {limit}</span>} MB
    </span>
  );
}
