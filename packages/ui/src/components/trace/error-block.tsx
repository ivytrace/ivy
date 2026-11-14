import type { SpanException } from "@/lib/spans/services";

export function ErrorBlock({ exception }: { exception: SpanException }) {
  return (
    <div className="max-h-[30rem] overflow-auto rounded-md border border-red-400/30 bg-red-500/5">
      <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed">
        <b className="text-red-400">
          {exception.type}: {exception.message}
        </b>
        {exception.stacktrace && (
          <>
            {"\n"}
            <span className="text-muted-foreground">
              {exception.stacktrace.split("\n").slice(exception.stacktrace.startsWith(exception.type) ? 1 : 0).join("\n")}
            </span>
          </>
        )}
      </pre>
    </div>
  );
}
