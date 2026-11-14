import { badgeVariants } from "@/components/ui/badge";
import { Tooltipped } from "@/components/ui/tooltipped";
import { formatCount, type CollapsedInfo, type SpanDescription } from "@/lib/spans/services";
import { cn } from "@/lib/utils/cn";

/** `× 1,184` on a summary span: similar calls the tracer collapsed into this one span. */
export function CollapsedBadge({ collapsed }: { collapsed: CollapsedInfo }) {
  return (
    <Tooltipped title={`${formatCount(collapsed.count)} similar calls summarised in one span`}>
      <span className={cn(badgeVariants({ variant: "outline" }), "ml-1.5 px-1.5 py-0 align-middle font-mono text-muted-foreground")}>
        × {formatCount(collapsed.count)}
      </span>
    </Tooltipped>
  );
}

/**
 * Title of a span row. With `stackNote`, an LLM span's note (tokens, time to first token, provider) goes on
 * its own smaller line below the title, so the model name and the note each get the row's full width.
 */
export function SpanTitle({
  description,
  count = 1,
  stackNote = false,
}: {
  description: SpanDescription;
  count?: number;
  stackNote?: boolean;
}) {
  const { operation, target, note, isInvocation, llm, collapsed } = description;
  const title = (
    <>
      {count > 1 && <span className="text-muted-foreground">({count}) </span>}
      {isInvocation ? (
        <>
          Function <code className="font-semibold">{target}</code>
        </>
      ) : (
        <>
          <span className="font-medium">{operation}</span>
          {target && (
            <>
              {llm ? <span className="text-muted-foreground"> · </span> : " "}
              <code className="text-foreground/90">{target}</code>
            </>
          )}
          {collapsed && <CollapsedBadge collapsed={collapsed} />}
        </>
      )}
    </>
  );
  if (stackNote && llm && note) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{note}</span>
      </span>
    );
  }
  return (
    <>
      {title}
      {note && <span className="text-muted-foreground"> – {note}</span>}
    </>
  );
}
