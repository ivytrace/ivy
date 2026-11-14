import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AppWindowIcon, CircleXIcon, CpuIcon, ListIcon, SearchIcon, WaypointsIcon } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useTimeRange } from "@/components/layout/time-range";
import { useFunctions } from "@/lib/api/hooks";
import { invocationsLink, pageLink, traceLink } from "@/lib/links/links";
import { useNavScope } from "@/lib/links/use-scope";

const TRACE_ID = /^[0-9a-f]{32}$/i;

export function SearchMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { range } = useTimeRange();
  const scope = useNavScope();
  const { data } = useFunctions(range);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const go = (url: string) => {
    navigate(url);
    setOpen(false);
    setQuery("");
  };

  const functions = [...(data?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const trimmed = query.trim();

  return (
    <>
      <Tooltipped title={<>Search <span className="text-muted-foreground">⌘K</span></>}>
        <Button variant="outline" size="icon" onClick={() => setOpen(true)} aria-label="Search">
          <SearchIcon className="size-4" />
        </Button>
      </Tooltipped>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Search functions, or paste a trace ID / request ID..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {trimmed && (
            <CommandGroup heading="Search">
              {scope && TRACE_ID.test(trimmed) && (
                <CommandItem value={`trace ${trimmed}`} onSelect={() => go(traceLink(scope, trimmed.toLowerCase()))}>
                  <WaypointsIcon className="mr-2 size-4" />
                  Open trace <code className="ml-1 text-xs">{trimmed}</code>
                </CommandItem>
              )}
              {scope && (
                <CommandItem value={`invocations ${trimmed}`} onSelect={() => go(invocationsLink(scope, { q: trimmed }))}>
                  <ListIcon className="mr-2 size-4" />
                  Search invocations for “{trimmed}”
                </CommandItem>
              )}
            </CommandGroup>
          )}
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => go(scope ? pageLink(scope, "functions") : "/functions")}>
              <AppWindowIcon className="mr-2 size-4" />
              Functions
            </CommandItem>
            <CommandItem onSelect={() => go(scope ? pageLink(scope, "invocations") : "/invocations")}>
              <ListIcon className="mr-2 size-4" />
              Invocations
            </CommandItem>
            <CommandItem onSelect={() => go(scope ? pageLink(scope, "errors") : "/errors")}>
              <CircleXIcon className="mr-2 size-4" />
              Errors
            </CommandItem>
          </CommandGroup>
          {scope && functions.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Functions">
                {functions.map((fn) => (
                  <CommandItem
                    key={`${fn.project ?? ""}/${fn.region}/${fn.name}`}
                    value={`${fn.name} ${fn.region} ${fn.project ?? ""}`}
                    onSelect={() =>
                      scope && go(invocationsLink({ workspace: scope.workspace, project: fn.project ?? scope.project }, { function: fn.name }))
                    }
                  >
                    <CpuIcon className="mr-2 size-4" />
                    <span className="flex-1 truncate">{fn.name}</span>
                    <span className="text-xs text-muted-foreground">{fn.project ? `${fn.project} · ${fn.region}` : fn.region}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
