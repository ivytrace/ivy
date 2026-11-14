import type { ErrorGroup, Invocation } from "@ivy/spans";
import { ms, oneLine, shortIso } from "../text/text.js";

const trigger = (t: string) => t.replace(/^aws:/, "") || "unknown";

/**
 * One line per invocation, e.g.
 * `2026-11-14T12:00:01Z ERROR checkout-createOrder 245ms cold POST /orders → 500 · TypeError: Cannot read… · trace 673f…`
 */
export function formatInvocationLine(inv: Invocation, messageChars = 140): string {
  const parts = [shortIso(inv.ts), inv.status === "error" ? "ERROR" : "ok", inv.function, ms(inv.duration_ms)];
  if (inv.cold_start) parts.push("cold");
  parts.push(
    inv.http_method && inv.http_path
      ? `${inv.http_method} ${inv.http_path}${inv.http_status ? ` → ${inv.http_status}` : ""}`
      : trigger(inv.trigger),
  );
  let line = parts.join(" ");
  if (inv.status === "error") {
    const message = [inv.error_type, inv.error_message].filter(Boolean).join(": ");
    line += ` · ${oneLine(message || "error", messageChars)}`;
  }
  return `${line} · trace ${inv.trace_id}`;
}

export function formatInvocations(items: Invocation[], messageChars?: number): string {
  if (!items.length) return "No invocations found.";
  return items.map((inv) => formatInvocationLine(inv, messageChars)).join("\n");
}

/** One line per error group: count, function, error, first/last seen and a sample trace. */
export function formatErrorGroups(items: ErrorGroup[]): string {
  if (!items.length) return "No errors found.";
  return items
    .map(
      (g) =>
        `${g.count}× ${g.function} · ${oneLine(`${g.error_type}: ${g.error_message}`, 160)}` +
        ` · first ${shortIso(g.first_seen)} · last ${shortIso(g.last_seen)} · sample trace ${g.sample_trace_id}`,
    )
    .join("\n");
}
