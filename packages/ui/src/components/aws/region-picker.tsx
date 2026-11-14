import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils/cn";

export interface RegionSelection {
  regions: string[];
  all_regions: boolean;
}

export function regionSummary({ regions, all_regions }: RegionSelection): string {
  if (all_regions) return "All enabled regions";
  if (regions.length <= 3) return regions.join(", ") || "No regions";
  return `${regions.slice(0, 2).join(", ")} +${regions.length - 2} more`;
}

/** Regions to scan. `locked` (the stack region) is always included unless all regions are selected. */
export function RegionPicker({
  value,
  onChange,
  options,
  locked,
}: {
  value: RegionSelection;
  onChange: (value: RegionSelection) => void;
  options: string[];
  locked?: string;
}) {
  const toggle = (region: string) => {
    const has = value.regions.includes(region);
    const regions = has ? value.regions.filter((r) => r !== region) : [...value.regions, region];
    onChange({ ...value, regions: options.filter((r) => regions.includes(r)) });
  };

  return (
    <div className="space-y-3">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal" disabled={value.all_regions}>
            <span className="truncate">
              {regionSummary({ ...value, regions: locked ? [locked, ...value.regions.filter((r) => r !== locked)] : value.regions })}
            </span>
            <ChevronDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1">
          {options.map((region) => {
            const checked = value.regions.includes(region) || region === locked;
            return (
              <button
                key={region}
                type="button"
                disabled={region === locked}
                onClick={() => toggle(region)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-sm hover:bg-accent disabled:opacity-60",
                )}
              >
                <span className={cn("flex size-4 items-center justify-center rounded border", checked && "border-primary bg-primary")}>
                  {checked && <Check className="size-3 text-primary-foreground" />}
                </span>
                {region}
                {region === locked && <span className="ml-auto font-sans text-xs text-muted-foreground">stack region</span>}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      <div className="flex items-center gap-2">
        <Switch
          id="all-regions"
          checked={value.all_regions}
          onCheckedChange={(all_regions) => onChange({ ...value, all_regions })}
        />
        <Label htmlFor="all-regions" className="text-sm font-normal text-muted-foreground">
          Scan all enabled regions
        </Label>
      </div>
    </div>
  );
}
