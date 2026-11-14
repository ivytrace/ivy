const ORIGINAL = Symbol.for('ivy.original');

/** Marks `wrapper` as an instrumented version of `original`. */
export function markWrapped<T extends Function>(wrapper: T, original: Function): T {
  Object.defineProperty(wrapper, ORIGINAL, { value: original });
  return wrapper;
}

/** The uninstrumented function behind `fn` (the layer's own requests must not be traced). */
export function unwrapped<T extends Function>(fn: T): T {
  return ((fn as any)[ORIGINAL] as T | undefined) ?? fn;
}
