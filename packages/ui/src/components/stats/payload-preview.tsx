import { useState, type ReactNode } from "react";
import { JSONTree } from "react-json-tree";
import { CUT_KEY, CUT_VALUE } from "@ivy/spans";
import { ChevronRight, Clipboard, ClipboardCheck, Maximize2, Minimize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltipped } from "@/components/ui/tooltipped";
import { cn } from "@/lib/utils/cn";

const theme = {
  scheme: "ivy-dark",
  base00: "transparent",
  base01: "#27272a",
  base02: "#3f3f46",
  base03: "#a1a1aa",
  base04: "#a1a1aa",
  base05: "#e4e4e7",
  base06: "#f4f4f5",
  base07: "#fafafa",
  base08: "#f87171",
  base09: "#fbbf24",
  base0A: "#fcd34d",
  base0B: "#86efac",
  base0C: "#67e8f9",
  base0D: "#93c5fd",
  base0E: "#c4b5fd",
  base0F: "#fb923c",
};

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || (typeof v === "object" && Object.keys(v as object).length === 0);

function CopyButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Tooltipped title="Copy">
      <Button variant="outline" size="miniIcon" onClick={copy} aria-label="Copy">
        {copied ? <ClipboardCheck className="size-3" /> : <Clipboard className="size-3" />}
      </Button>
    </Tooltipped>
  );
}

export function JsonValue({ value }: { value: unknown }) {
  const [expandAll, setExpandAll] = useState(false);

  if (typeof value !== "object" || value === null) {
    return (
      <div className="group relative">
        <div className="absolute right-3 top-3 z-20 hidden gap-2 group-hover:flex">
          <CopyButton value={value} />
        </div>
        <pre className="whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs">{String(value)}</pre>
      </div>
    );
  }

  return (
    <div className="group relative px-2 pb-3 font-mono text-xs">
      <div className="absolute right-3 top-3 z-20 hidden gap-2 group-hover:flex">
        <CopyButton value={value} />
        <Tooltipped title={expandAll ? "Collapse all" : "Expand all"}>
          <Button variant="outline" size="miniIcon" onClick={() => setExpandAll(!expandAll)} aria-label="Toggle expand">
            {expandAll ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </Button>
        </Tooltipped>
      </div>
      <JSONTree
        key={String(expandAll)}
        data={value}
        theme={theme}
        invertTheme={false}
        hideRoot
        shouldExpandNodeInitially={(_keyPath, _data, level) => expandAll || level < 2}
        labelRenderer={([key]) => (key === CUT_KEY ? null : `${key}:`)}
        valueRenderer={(text, raw, key) =>
          raw === CUT_VALUE && (key === CUT_KEY || typeof key === "number") ? (
            <span className="italic text-muted-foreground">… truncated</span>
          ) : (
            (text as ReactNode)
          )
        }
      />
    </div>
  );
}

export function PayloadPreview({
  title,
  value,
  truncated = false,
  defaultOpen = true,
  className,
}: {
  title: string;
  value: unknown;
  truncated?: boolean;
  defaultOpen?: boolean;
  className?: string;
}) {
  if (isEmpty(value)) return null;
  return (
    <details open={defaultOpen} className={cn("group/payload rounded-md border", className)}>
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open/payload:rotate-90" />
        {title}
        {truncated && <span className="font-normal text-amber-400">(truncated)</span>}
      </summary>
      <div className="max-h-[30rem] overflow-auto border-t">
        <JsonValue value={value} />
      </div>
    </details>
  );
}
