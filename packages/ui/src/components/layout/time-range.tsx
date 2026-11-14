import { createContext, useContext, useState, type ReactNode } from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Since, TimeRange } from "@/lib/api/types";

const PRESETS: { since: Since; label: string }[] = [
  { since: "15m", label: "Last 15 minutes" },
  { since: "1h", label: "Last hour" },
  { since: "24h", label: "Last 24 hours" },
  { since: "7d", label: "Last 7 days" },
];

const STORAGE_KEY = "ivy/time-range";

interface TimeRangeState {
  range: TimeRange;
  setRange: (range: TimeRange) => void;
}

const TimeRangeContext = createContext<TimeRangeState | null>(null);

function loadRange(): TimeRange {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && PRESETS.some((p) => p.since === stored)) return { since: stored as Since };
  } catch {
    // storage unavailable
  }
  return { since: "24h" };
}

export function TimeRangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<TimeRange>(loadRange);
  const setRange = (next: TimeRange) => {
    setRangeState(next);
    try {
      if ("since" in next) localStorage.setItem(STORAGE_KEY, next.since);
    } catch {
      // storage unavailable
    }
  };
  return <TimeRangeContext.Provider value={{ range, setRange }}>{children}</TimeRangeContext.Provider>;
}

export function useTimeRange(): TimeRangeState {
  const ctx = useContext(TimeRangeContext);
  if (!ctx) throw new Error("useTimeRange must be used inside TimeRangeProvider");
  return ctx;
}

export function rangeLabel(range: TimeRange): string {
  if ("since" in range) return PRESETS.find((p) => p.since === range.since)?.label ?? range.since;
  return `${format(new Date(range.from), "MMM d, HH:mm")} – ${format(new Date(range.to), "MMM d, HH:mm")}`;
}

const toLocalInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

export function TimeRangePicker() {
  const { range, setRange } = useTimeRange();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => toLocalInput(new Date(Date.now() - 3600_000)));
  const [to, setTo] = useState(() => toLocalInput(new Date()));

  const apply = (next: TimeRange) => {
    setRange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="px-3">
          <CalendarIcon className="mr-2 size-4" />
          {rangeLabel(range)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex flex-col divide-y sm:flex-row sm:divide-x sm:divide-y-0">
          <div className="flex w-44 flex-col gap-1 p-3">
            {PRESETS.map((preset) => (
              <Button
                key={preset.since}
                variant={"since" in range && range.since === preset.since ? "secondary" : "ghost"}
                className="justify-start"
                size="sm"
                onClick={() => apply({ since: preset.since })}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <form
            className="flex w-64 flex-col gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              apply({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
            }}
          >
            <div className="text-sm font-medium">Custom range</div>
            <div className="grid gap-1.5">
              <Label htmlFor="range-from" className="text-xs text-muted-foreground">From</Label>
              <Input id="range-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="range-to" className="text-xs text-muted-foreground">To</Label>
              <Input id="range-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={!from || !to || from >= to}>
              Apply
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
