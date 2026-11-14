/**
 * Error message templates: the message with its variable parts (IDs, paths, numbers, …) replaced by
 * placeholders, so `Upload not found for ID: favicon.ico` and `… ID: fonts/semibold.woff2` are one error group
 * (`Upload not found for ID: {path}`). See docs/implementation/error-grouping.md.
 *
 * The rules are written once and run in two places: here (`errorTemplate`) and in ClickHouse at query time
 * (`errorTemplateSql`, nested `replaceRegexpAll`). Patterns therefore stick to what JavaScript and RE2 agree on:
 * ASCII classes, `\b`/`\B`, `(?:…)`, no lookaround, no `\s`. Replacements use `$1` (converted to `\1` for SQL).
 */

/** The first line of a message is cut to this many characters before normalizing. */
export const TEMPLATE_MAX_CHARS = 300;

/** Error types whose message names what is missing (a module, a handler): their messages are kept as they are. */
export const VERBATIM_MESSAGE_TYPES = ["Runtime.ImportModuleError", "Runtime.HandlerNotFound"];

export const PLACEHOLDERS = ["id", "num", "email", "url", "ip", "date", "path", "str"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const EXTENSIONS =
  "m?js|cjs|jsx|tsx?|map|json|html?|css|scss|txt|csv|tsv|xml|ya?ml|md|pdf|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|" +
  "woff2?|ttf|otf|eot|mp3|mp4|wav|webm|mov|zip|gz|tgz|tar|br|zst|wasm|py|rb|go|java|php|sql|log|bin|dat|parquet|" +
  "avro|docx?|xlsx?|pptx?|toml|ini|conf|lock|sh";
/** Characters of a path segment. */
const SEG = "[A-Za-z0-9_.~@%+-]";
const HEX = "[0-9a-fA-F]";

/** In order: quoted text first (so nothing inside a long quote is touched), the generic number rule last but one. */
export const TEMPLATE_RULES: ReadonlyArray<{ name: string; pattern: string; replacement: string }> = [
  // Quoted text with a space, or longer than 40 characters. Short single words stay ('id', "GET", `left-pad`):
  // `reading 'id'` and `reading 'map'` are different bugs. \B keeps apostrophes inside words (can't) out.
  { name: "quoted", pattern: `\\B'[^'\\n]*[ \\t][^'\\n]*'\\B|\\B'[^'\\n]{41,}'\\B`, replacement: "{str}" },
  { name: "dquoted", pattern: `\\B"[^"\\n]*[ \\t][^"\\n]*"\\B|\\B"[^"\\n]{41,}"\\B`, replacement: "{str}" },
  { name: "backquoted", pattern: "\\B`[^`\\n]*[ \\t][^`\\n]*`\\B|\\B`[^`\\n]{41,}`\\B", replacement: "{str}" },
  { name: "url", pattern: `\\b[A-Za-z][A-Za-z0-9+.-]*://[^ \\t'"<>()\\[\\]{}]+`, replacement: "{url}" },
  { name: "email", pattern: `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}\\b`, replacement: "{email}" },
  { name: "uuid", pattern: `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`, replacement: "{id}" },
  {
    name: "date",
    pattern: `\\b[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?`,
    replacement: "{date}",
  },
  { name: "ip", pattern: `\\b[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}(?::[0-9]+)?\\b`, replacement: "{ip}" },
  { name: "arn", pattern: `\\barn:aws[A-Za-z-]*:[^ \\t'"(),]+`, replacement: "{id}" },
  // Paths: absolute or ./ ../ ~/ ones, relative ones with an extension or two slashes, and file names with a known
  // extension (favicon.ico, _mermaid.js). `application/json`, `and/or` and capitalised words like Node.js stay.
  { name: "abspath", pattern: `(^|[^A-Za-z0-9_.~@%+/-])(?:~|\\.{1,2})?/${SEG}[A-Za-z0-9_.~@%+/-]*`, replacement: "$1{path}" },
  { name: "relpath", pattern: `${SEG}+/[A-Za-z0-9_.~@%+/-]*\\.(?:${EXTENSIONS})\\b|${SEG}+(?:/${SEG}+){2,}`, replacement: "{path}" },
  { name: "file", pattern: `\\b[a-z0-9_-][A-Za-z0-9_.~@%+-]*\\.(?:${EXTENSIONS})\\b`, replacement: "{path}" },
  // Prefixed IDs with a digit: cus_NffrFeUfNV2Hib, ten_8f2k1, usr_123.
  { name: "prefixed", pattern: `\\b[A-Za-z]{2,12}_[A-Za-z0-9]*[0-9][A-Za-z0-9]*\\b`, replacement: "{id}" },
  { name: "hex", pattern: `\\b${HEX}{8,}\\b`, replacement: "{id}" },
  // Numbers on their own (not v2, utf8, s3), with an optional unit: 42, -1, 3.00, 1.2.3, 500ms, 10MB.
  {
    name: "number",
    pattern: `(^-?|[^A-Za-z0-9_.-]|[^A-Za-z0-9_]-)[0-9]+(?:\\.[0-9]+)*(ms|s|m|h|d|b|kb|mb|gb|KB|MB|GB|x)?\\b`,
    replacement: "$1{num}$2",
  },
  // The single token after `id:`, `userId=`, `key:` …
  {
    name: "keyed",
    pattern: `(\\b(?:[a-z]+(?:Id|ID|Key)|[a-z]+_(?:id|key)|id|ID|Id|key|Key|KEY|uuid|UUID)[ \\t]*[:=][ \\t]*)[^ \\t'"{}(),;\\[\\]]+`,
    replacement: "$1{id}",
  },
];

const compiled = TEMPLATE_RULES.map((r) => ({ re: new RegExp(r.pattern, "g"), replacement: r.replacement }));

/** The first line of a message, trimmed and cut to `TEMPLATE_MAX_CHARS` characters (code points). */
export function templateInput(message: string): string {
  const line = message.split("\n", 1)[0].replace(/^[ \t\r]+|[ \t\r]+$/g, "");
  return Array.from(line).slice(0, TEMPLATE_MAX_CHARS).join("");
}

/** The message template of an error (see the file comment). */
export function errorTemplate(message: string, errorType = ""): string {
  const input = templateInput(message);
  if (VERBATIM_MESSAGE_TYPES.includes(errorType)) return input;
  return compiled.reduce((s, r) => s.replace(r.re, r.replacement), input);
}

const sqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * `errorTemplate` as a ClickHouse expression over the given message and error type columns: the same first line,
 * trimming and cut (`substringUTF8` counts code points), then the same rules.
 */
export function errorTemplateSql(message = "error_message", errorType = "error_type"): string {
  const input = `substringUTF8(replaceRegexpAll(splitByChar('\\n', ${message})[1], '^[ \\t\\r]+|[ \\t\\r]+$', ''), 1, ${TEMPLATE_MAX_CHARS})`;
  const normalized = TEMPLATE_RULES.reduce(
    (expr, r) => `replaceRegexpAll(${expr}, ${sqlString(r.pattern)}, ${sqlString(r.replacement.replace(/\$(\d)/g, "\\$1"))})`,
    input,
  );
  return `if(${errorType} IN (${VERBATIM_MESSAGE_TYPES.map(sqlString).join(", ")}), ${input}, ${normalized})`;
}

/** A template split into text and placeholders, for display (`{path}` muted). */
export function templateParts(template: string): Array<{ text: string; placeholder: boolean }> {
  const parts: Array<{ text: string; placeholder: boolean }> = [];
  const re = new RegExp(`\\{(?:${PLACEHOLDERS.join("|")})\\}`, "g");
  let last = 0;
  for (const m of template.matchAll(re)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index), placeholder: false });
    parts.push({ text: m[0], placeholder: true });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last), placeholder: false });
  return parts;
}
