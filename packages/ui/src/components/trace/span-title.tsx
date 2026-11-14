import type { SpanDescription } from "@/lib/spans/services";

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
  const { operation, target, note, isInvocation, llm } = description;
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
