import { EmptyState } from "@/components/common/states";
import type { LogLine } from "@/lib/spans/services";
import { cn } from "@/lib/utils/cn";
import { formatTime } from "@/lib/utils/format";

const SEVERITY_COLORS: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-red-400",
};

export function Logs({ logs }: { logs: LogLine[] }) {
  if (!logs.length) {
    return <EmptyState title="No logs" description="console.* output during the invocation appears here." />;
  }
  return (
    <div className="divide-y rounded-md border font-mono text-xs">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-3 px-4 py-2 hover:bg-muted/30">
          <span className="shrink-0 text-muted-foreground">{formatTime(log.ts)}</span>
          <span className={cn("w-10 shrink-0 uppercase", SEVERITY_COLORS[log.severity])}>{log.severity}</span>
          <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", log.severity === "error" && "text-red-300")}>
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}
