import { formatDistanceToNowStrict, format } from "date-fns";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toLocaleString("en", { maximumFractionDigits: ms < 10 ? 1 : 0 })} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("en", { maximumFractionDigits: 2 })} s`;
  return `${(ms / 60_000).toLocaleString("en", { maximumFractionDigits: 1 })} min`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en", { maximumFractionDigits: 1 });
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toLocaleString("en", { maximumFractionDigits: ratio < 0.01 ? 2 : 1 })}%`;
}

export function formatAgo(iso: string): string {
  return `${formatDistanceToNowStrict(new Date(iso))} ago`;
}

export function formatTimestamp(iso: string): string {
  return format(new Date(iso), "MMM d, HH:mm:ss.SSS");
}

export function formatTime(iso: string): string {
  return format(new Date(iso), "HH:mm:ss.SSS");
}
