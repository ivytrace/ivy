import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useAttributeKeys } from "@/lib/api/hooks";
import type { TimeRange } from "@/lib/api/types";
import { applyKey, suggestKeys, tokenAt } from "@/lib/search/attribute-suggestions";
import { cn } from "@/lib/utils/cn";

/**
 * The invocation list's search box. While a word is typed it suggests the span attribute keys in use
 * (`key=` terms); Enter searches unless a suggestion is highlighted with the arrow keys.
 */
export function InvocationSearch({ q, range, onSearch }: { q: string | undefined; range: TimeRange; onSearch: (q: string | undefined) => void }) {
  const [draft, setDraft] = useState(q ?? "");
  const [caret, setCaret] = useState(draft.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextCaret = useRef<number | null>(null);
  const listId = useId();
  const keys = useAttributeKeys(range, focused);

  useEffect(() => setDraft(q ?? ""), [q]);
  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [draft]);

  const suggestions = open ? suggestKeys(keys.data?.items.map((k) => k.key) ?? [], tokenAt(draft, caret).text) : [];
  const submit = () => {
    setOpen(false);
    if (draft.trim() !== (q ?? "")) onSearch(draft.trim() || undefined);
  };
  const pick = (key: string) => {
    const next = applyKey(draft, caret, key);
    nextCaret.current = next.caret;
    setDraft(next.value);
    setCaret(next.caret);
    setActive(-1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + suggestions.length + (i < 0 && step < 0 ? 1 : 0)) % suggestions.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <form
      className="relative w-full sm:w-auto"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={input}
        placeholder="Request/trace ID, error, path, key=value…"
        title='Matches a request ID, trace ID, error message or HTTP path. key=value matches a span attribute on any span of the invocation, e.g. job.id=abc123 or job.reason="manual retry".'
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
          setActive(-1);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? draft.length)}
        onFocus={() => {
          setFocused(true);
          setOpen(true);
        }}
        onBlur={submit}
        onKeyDown={onKeyDown}
        className="h-8 w-full pl-9 sm:w-80"
        autoComplete="off"
        role="combobox"
        aria-label="Search invocations"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
      />
      {suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Span attributes"
          className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((key, i) => (
            <li
              key={key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn(
                "cursor-default select-none truncate rounded-sm px-2 py-1 font-mono text-xs max-md:py-2.5",
                i === active && "bg-accent text-accent-foreground",
              )}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(key)}
            >
              {key}
              <span className="text-muted-foreground">=</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
