import type { SpanDescription } from "@/lib/spans/services";

export function SpanTitle({ description, count = 1 }: { description: SpanDescription; count?: number }) {
  const { operation, target, note, isInvocation } = description;
  return (
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
              {" "}
              <code className="text-foreground/90">{target}</code>
            </>
          )}
        </>
      )}
      {note && <span className="text-muted-foreground"> – {note}</span>}
    </>
  );
}
