/** Key and value of the entry that marks where a repaired payload was cut. */
export const CUT_KEY = "…";
export const CUT_VALUE = "[truncated]";

const INCOMPLETE = Symbol("incomplete");
type Parsed = unknown | typeof INCOMPLETE;

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const LITERAL = /-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null/y;
const PARTIAL_LITERAL = /^(-|-?\d+\.?\d*([eE][+-]?\d*)?|t(r(ue?)?)?|f(a(l(se?)?)?)?|n(u(ll?)?)?)$/;

function hasContent(value: object): boolean {
  if (Array.isArray(value)) return value.length > 1;
  return Object.keys(value).length > 1;
}

/**
 * Best-effort value of a JSON object or array whose text was cut off: the valid prefix is kept, a
 * string cut mid-way ends in "…", a dangling key or partial number/literal is dropped, and every
 * container that was still open gets a `CUT_KEY: CUT_VALUE` entry (arrays: a `CUT_VALUE` item) at the
 * end. Returns undefined when the text is not a cut JSON object/array or nothing was recovered.
 */
export function repairTruncatedJson(text: string): object | undefined {
  let i = 0;
  let cut = false;

  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break;
      i++;
    }
  };

  const string = (isKey: boolean): string | typeof INCOMPLETE => {
    i++;
    let out = "";
    while (i < text.length) {
      let end = i;
      while (end < text.length && text[end] !== '"' && text[end] !== "\\") end++;
      out += text.slice(i, end);
      i = end;
      if (i >= text.length) break;
      if (text[i] === '"') {
        i++;
        return out;
      }
      const e = text[i + 1];
      if (e === undefined) break;
      if (e === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw new SyntaxError();
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        if (!(e in ESCAPES)) throw new SyntaxError();
        out += ESCAPES[e];
        i += 2;
      }
    }
    i = text.length;
    cut = true;
    if (isKey) return INCOMPLETE;
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    return `${out}…`;
  };

  const literal = (): Parsed => {
    if (text.length - i < 32 && PARTIAL_LITERAL.test(text.slice(i))) {
      i = text.length;
      cut = true;
      return INCOMPLETE;
    }
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) throw new SyntaxError();
    i += m[0].length;
    return JSON.parse(m[0]);
  };

  const value = (): Parsed => {
    ws();
    if (i >= text.length) {
      cut = true;
      return INCOMPLETE;
    }
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string(false);
    return literal();
  };

  const array = (): unknown[] => {
    i++;
    const out: unknown[] = [];
    for (;;) {
      ws();
      if (i >= text.length) break;
      if (text[i] === "]" && out.length === 0) {
        i++;
        return out;
      }
      const v = value();
      if (v !== INCOMPLETE) out.push(v);
      if (cut) break;
      ws();
      if (i >= text.length) break;
      if (text[i] === "]") {
        i++;
        return out;
      }
      if (text[i] !== ",") throw new SyntaxError();
      i++;
    }
    cut = true;
    out.push(CUT_VALUE);
    return out;
  };

  const object = (): Record<string, unknown> => {
    i++;
    const out: Record<string, unknown> = {};
    const set = (k: string, v: unknown) =>
      Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    let first = true;
    for (;;) {
      ws();
      if (i >= text.length) break;
      if (text[i] === "}" && first) {
        i++;
        return out;
      }
      first = false;
      if (text[i] !== '"') throw new SyntaxError();
      const key = string(true);
      if (key === INCOMPLETE) break;
      ws();
      if (i >= text.length) break;
      if (text[i] !== ":") throw new SyntaxError();
      i++;
      const v = value();
      if (v !== INCOMPLETE) set(key, v);
      if (cut) break;
      ws();
      if (i >= text.length) break;
      if (text[i] === "}") {
        i++;
        return out;
      }
      if (text[i] !== ",") throw new SyntaxError();
      i++;
    }
    cut = true;
    set(CUT_KEY, CUT_VALUE);
    return out;
  };

  try {
    ws();
    if (text[i] !== "{" && text[i] !== "[") return undefined;
    const result = value() as object;
    if (!cut) return undefined;
    return hasContent(result) ? result : undefined;
  } catch {
    return undefined;
  }
}
