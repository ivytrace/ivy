import { CheckCircle2, CircleX, SnowflakeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltipped } from "@/components/ui/tooltipped";

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

export function InvocationStatus({
  ok,
  errorType,
  errorMessage,
  httpStatus,
}: {
  ok: boolean;
  errorType?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | string | null;
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
