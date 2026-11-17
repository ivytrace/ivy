/**
 * Log lines written by JSON loggers (Powertools, pino, winston, bunyan, hand-rolled `console.log(JSON.stringify(…))`):
 * the message, the level and the fields worth reading, with the Lambda context every line repeats set aside.
 */

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface StructuredLog {
  /** The parsed object. */
  data: Record<string, unknown>;
  /** `level` / `severity` normalized, when the line has one. */
  level?: LogSeverity;
  /** The logger's or event's name (`name`), shown as a label. */
  name?: string;
  /** `message` or `msg`. */
  message?: string;
  /** Every other field except Lambda and logger context, in the line's order. */
  fields: [key: string, value: unknown][];
}

const LEVEL_KEYS = ["level", "severity", "levelname", "log.level"];
const MESSAGE_KEYS = ["message", "msg"];

/**
 * Fields loggers add to every line of an invocation: timestamps, process and Lambda context. Hidden from the line
 * (they stay in the full JSON).
 */
export const LOG_CONTEXT_KEYS = new Set([
  "time",
  "timestamp",
  "ts",
  "@timestamp",
  "pid",
  "hostname",
  "v",
  "awsRegion",
  "functionName",
  "functionVersion",
  "functionMemorySize",
  "function_name",
  "function_version",
  "function_memory_size",
  "function_arn",
  "function_request_id",
  "requestId",
  "awsRequestId",
  "aws_request_id",
  "request_id",
  "xray_trace_id",
  "xrayTraceId",
  "cold_start",
  "coldStart",
  "sampling_rate",
]);

/** String levels (any case) and pino/bunyan numbers (10 trace … 60 fatal). */
export function normalizeLevel(value: unknown): LogSeverity | undefined {
  if (typeof value === "number") {
    if (value >= 50) return "error";
    if (value >= 40) return "warn";
    if (value >= 30) return "info";
    return value > 0 ? "debug" : undefined;
  }
  if (typeof value !== "string") return undefined;
  const level = value.trim().toLowerCase();
  if (level === "debug" || level === "trace" || level === "verbose" || level === "silly") return "debug";
  if (level === "info" || level === "information" || level === "notice" || level === "log") return "info";
  if (level === "warn" || level === "warning") return "warn";
  if (level === "error" || level === "fatal" || level === "critical" || level === "crit" || level === "alert" || level === "emerg") return "error";
  return undefined;
}

/** The line as a structured log, or null when it isn't a JSON object. */
export function parseStructuredLog(line: string): StructuredLog | null {
  const text = line.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const levelKey = LEVEL_KEYS.find((k) => k in obj);
  const messageKey = MESSAGE_KEYS.find((k) => typeof obj[k] === "string");
  const name = typeof obj.name === "string" && obj.name ? obj.name : undefined;
  const skip = new Set([levelKey, messageKey, name !== undefined ? "name" : undefined]);
  return {
    data: obj,
    level: levelKey ? normalizeLevel(obj[levelKey]) : undefined,
    name,
    message: messageKey ? (obj[messageKey] as string) : undefined,
    fields: Object.entries(obj).filter(([k]) => !skip.has(k) && !LOG_CONTEXT_KEYS.has(k)),
  };
}

/** A field value as one short string: strings as they are, everything else as JSON. */
export const fieldText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Fields with the same value on every structured line (at least two lines): context like `stage` or `buildId` that
 * reads better once, above the lines, than on each of them.
 */
export function sharedFields(logs: (StructuredLog | null)[]): [key: string, value: unknown][] {
  const structured = logs.filter((l): l is StructuredLog => l !== null);
  if (structured.length < 2) return [];
  const [first, ...rest] = structured;
  return first.fields.filter(([key, value]) =>
    rest.every((l) => l.fields.some(([k, v]) => k === key && fieldText(v) === fieldText(value))),
  );
}

/** A structured line as one line of text: `name: message key=value …` (for the LLM text format). */
export function structuredLogText(log: StructuredLog): string {
  const head = [log.name, log.message].filter(Boolean).join(": ");
  const fields = log.fields.map(([k, v]) => `${k}=${fieldText(v)}`);
  return [head, ...fields].filter(Boolean).join(" ");
}
