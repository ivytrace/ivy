/** The start of a `key=value` term's key, as the API reads it (`invocation-search.ts`). */
const KEY_START = /^[A-Za-z_][\w.\-/:@]*$/;

export interface Token {
  start: number;
  end: number;
  text: string;
}

/** The word the caret is in or right after: what a suggestion replaces. */
export function tokenAt(value: string, caret: number): Token {
  const start = value.slice(0, caret).search(/\S*$/);
  const end = caret + value.slice(caret).search(/\s|$/);
  return { start, end, text: value.slice(start, end) };
}

/**
 * Attribute keys to offer for the word being typed, from `keys` (most used first): those starting with it, then
 * those containing it. None once the word has its `=` (the value is being typed) or can't start a key.
 */
export function suggestKeys(keys: string[], token: string, limit = 8): string[] {
  if (token && !KEY_START.test(token)) return [];
  const typed = token.toLowerCase();
  const prefixed = keys.filter((key) => key.toLowerCase().startsWith(typed));
  const containing = keys.filter((key) => !prefixed.includes(key) && key.toLowerCase().includes(typed));
  return [...prefixed, ...containing].slice(0, limit);
}

/** Replaces the word at the caret with `key=`, leaving the caret after the `=` for the value. */
export function applyKey(value: string, caret: number, key: string): { value: string; caret: number } {
  const { start, end } = tokenAt(value, caret);
  const term = `${key}=`;
  return { value: value.slice(0, start) + term + value.slice(end), caret: start + term.length };
}
