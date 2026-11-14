import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { JsonValue, PayloadPreview } from "@/components/stats/payload-preview";
import { formatTokens, type LlmMessage, type LlmPart, type LlmSpan, type LlmUsage } from "@/lib/spans/services";
import { cn } from "@/lib/utils/cn";

const ROLE_STYLES: Record<string, string> = {
  system: "bg-amber-400/10 text-amber-300",
  user: "bg-sky-400/10 text-sky-300",
  assistant: "bg-violet-400/10 text-violet-300",
  tool: "bg-emerald-400/10 text-emerald-300",
};

const CLAMP_CHARS = 600;
const CLAMP_LINES = 10;

function Section({ title, defaultOpen = true, children }: { title: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group/section rounded-md border">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open/section:rotate-90" />
        {title}
      </summary>
      <div className="max-h-[40rem] overflow-auto border-t">{children}</div>
    </details>
  );
}

/** Inline markdown kept to `code` and **bold**; everything is rendered as text, never as HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((piece, i) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[11px]">
          {piece.slice(1, -1)}
        </code>
      );
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) return <strong key={i}>{piece.slice(2, -2)}</strong>;
    return piece;
  });
}

/** Message text with fenced code blocks and minimal inline formatting; long text is clamped. */
function MessageText({ text, muted = false }: { text: string; muted?: boolean }) {
  const lines = text.split("\n");
  const long = text.length > CLAMP_CHARS || lines.length > CLAMP_LINES;
  const [expanded, setExpanded] = useState(false);
  let shown = text;
  if (long && !expanded) {
    shown = lines.slice(0, CLAMP_LINES).join("\n");
    if (shown.length > CLAMP_CHARS) shown = shown.slice(0, CLAMP_CHARS);
    shown = `${shown.trimEnd()}…`;
  }
  const blocks = shown.split("```");
  return (
    <div className={cn("text-xs leading-relaxed", muted && "italic text-muted-foreground")}>
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1.5 overflow-x-auto rounded bg-muted/60 px-3 py-2 font-mono text-[11px]">
            {block.replace(/^[\w-]*\n/, "")}
          </pre>
        ) : (
          block && (
            <p key={i} className="whitespace-pre-wrap break-words">
              {inline(block)}
            </p>
          )
        ),
      )}
      {long && (
        <button type="button" className="mt-1 text-[11px] text-primary hover:underline" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show all (${text.length.toLocaleString("en")} characters)`}
        </button>
      )}
    </div>
  );
}

function ToolBlock({ label, name, id, value }: { label: string; name?: string; id?: string; value: unknown }) {
  return (
    <div className="rounded-md border bg-muted/10">
      <div className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">{label}</span>
        {name && <code className="font-medium">{name}</code>}
        {id && <span className="font-mono text-[10px] text-muted-foreground">{id}</span>}
      </div>
      {value !== undefined && (
        <div className="border-t">
          <JsonValue value={value} />
        </div>
      )}
    </div>
  );
}

function Part({ part }: { part: LlmPart }) {
  switch (part.type) {
    case "text":
      return <MessageText text={part.text} />;
    case "reasoning":
      return <MessageText text={part.text} muted />;
    case "tool_call":
      return <ToolBlock label="Tool call" name={part.name} id={part.id} value={part.arguments} />;
    case "tool_result":
      return <ToolBlock label="Tool result" name={part.name} id={part.id} value={part.result} />;
    default:
      return <span className="text-xs text-muted-foreground">[{part.label}]</span>;
  }
}

export function Conversation({ messages }: { messages: LlmMessage[] }) {
  return (
    <div className="divide-y">
      {messages.map((m, i) => (
        <div key={i} className="flex gap-3 px-3 py-2.5">
          <div className="w-16 shrink-0 pt-px">
            <span
              className={cn(
                "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                ROLE_STYLES[m.role] ?? "bg-muted text-muted-foreground",
              )}
            >
              {m.role}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {m.parts.length ? m.parts.map((p, j) => <Part key={j} part={p} />) : <span className="text-xs text-muted-foreground">(empty)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Conversation, response, tool call and settings of an LLM, agent or tool span. */
export function LlmDetails({ llm }: { llm: LlmSpan }) {
  return (
    <div className="flex flex-col gap-3">
      {llm.settings.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {llm.settings.map((s) => (
            <span key={s.label} className="rounded-md border px-2 py-0.5 text-[11px]">
              <span className="text-muted-foreground">{s.label}</span> <span className="font-mono">{s.value}</span>
            </span>
          ))}
        </div>
      )}
      {llm.tool && (
        <>
          <PayloadPreview title="Arguments" value={llm.tool.arguments} />
          <PayloadPreview title="Result" value={llm.tool.result} />
        </>
      )}
      {llm.messages.length > 0 && (
        <Section title={`Messages (${llm.messages.length})`}>
          <Conversation messages={llm.messages} />
        </Section>
      )}
      {llm.output.length > 0 && (
        <Section title="Response">
          <Conversation messages={llm.output} />
        </Section>
      )}
      {llm.tools.length > 0 && (
        <Section title={`Tools offered (${llm.tools.length})`} defaultOpen={false}>
          <ul className="divide-y text-xs">
            {llm.tools.map((t) => (
              <li key={t.name} className="px-3 py-2">
                <code className="font-medium">{t.name}</code>
                {t.description && <span className="text-muted-foreground"> – {t.description}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** Token totals per model for the trace overview. */
export function LlmUsageTable({ usage }: { usage: LlmUsage }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-medium">Model</th>
            <th className="px-3 py-2 text-left font-medium">Provider</th>
            <th className="px-3 py-2 text-right font-medium">Calls</th>
            <th className="px-3 py-2 text-right font-medium">Input tokens</th>
            <th className="px-3 py-2 text-right font-medium">Output tokens</th>
          </tr>
        </thead>
        <tbody className="divide-y tabular-nums">
          {usage.byModel.map((row) => (
            <tr key={`${row.provider}|${row.model}`}>
              <td className="px-3 py-2 font-mono">{row.model ?? "unknown"}</td>
              <td className="px-3 py-2">{row.providerLabel ?? "–"}</td>
              <td className="px-3 py-2 text-right">{row.calls}</td>
              <td className="px-3 py-2 text-right">{formatTokens(row.inputTokens)}</td>
              <td className="px-3 py-2 text-right">{formatTokens(row.outputTokens)}</td>
            </tr>
          ))}
          {usage.byModel.length > 1 && (
            <tr className="font-medium">
              <td className="px-3 py-2" colSpan={2}>
                Total
              </td>
              <td className="px-3 py-2 text-right">{usage.calls}</td>
              <td className="px-3 py-2 text-right">{formatTokens(usage.inputTokens)}</td>
              <td className="px-3 py-2 text-right">{formatTokens(usage.outputTokens)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
