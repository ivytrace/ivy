import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { EmptyState } from "@/components/common/states";
import { JsonValue } from "@/components/stats/payload-preview";
import { fieldText, sharedFields, type LogLine } from "@/lib/spans/services";
import { cn } from "@/lib/utils/cn";
import { formatTime } from "@/lib/utils/format";

const SEVERITY_COLORS: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-red-400",
};

const MAX_VALUE_CHARS = 160;

function Fields({ fields }: { fields: [string, unknown][] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {fields.map(([key, value]) => {
        const text = fieldText(value);
        return (
          <span key={key} className="min-w-0 break-all" title={text.length > MAX_VALUE_CHARS ? text : undefined}>
            <span className="text-muted-foreground">{key}</span> {text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text}
          </span>
        );
      })}
    </span>
  );
}

/** A JSON logger's line: name, message and its own fields; the full JSON on click. */
function StructuredLine({ log, hidden }: { log: LogLine; hidden: Set<string> }) {
  const [open, setOpen] = useState(false);
  const s = log.structured!;
  const fields = s.fields.filter(([key]) => !hidden.has(key));
  return (
    <div className="min-w-0 flex-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full min-w-0 gap-2 text-left">
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className={cn("block whitespace-pre-wrap break-words", log.severity === "error" && "text-red-300")}>
            {s.name && <span className="mr-2 rounded bg-muted px-1.5 py-px text-[11px] text-zinc-300">{s.name}</span>}
            {s.message ?? (fields.length ? null : <span className="text-muted-foreground">(no message)</span>)}
          </span>
          {fields.length > 0 && <Fields fields={fields} />}
        </span>
        <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-2 rounded border bg-background">
          <JsonValue value={s.data} />
        </div>
      )}
    </div>
  );
}

export function Logs({ logs }: { logs: LogLine[] }) {
  // Context every JSON line repeats (stage, build, …) is shown once, above the lines.
  const shared = useMemo(() => sharedFields(logs.map((l) => l.structured)), [logs]);
  const hidden = useMemo(() => new Set(shared.map(([key]) => key)), [shared]);

  if (!logs.length) {
    return <EmptyState title="No logs" description="console.* output during the invocation appears here." />;
  }
  return (
    <div className="divide-y rounded-md border font-mono text-xs">
      {shared.length > 0 && (
        <div className="flex gap-3 bg-muted/20 px-4 py-2">
          <span className="shrink-0 text-muted-foreground">In every line</span>
          <Fields fields={shared} />
        </div>
      )}
      {logs.map((log, i) => (
        <div key={i} className="flex gap-3 px-4 py-2 hover:bg-muted/30">
          <span className="shrink-0 text-muted-foreground">{formatTime(log.ts)}</span>
          <span className={cn("w-10 shrink-0 uppercase", SEVERITY_COLORS[log.severity])}>{log.severity}</span>
          {log.structured ? (
            <StructuredLine log={log} hidden={hidden} />
          ) : (
            <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", log.severity === "error" && "text-red-300")}>{log.message}</span>
          )}
        </div>
      ))}
    </div>
  );
}
