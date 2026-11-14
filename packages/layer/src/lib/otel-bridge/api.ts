/**
 * The parts of the `@opentelemetry/api` contract the bridge implements. Every copy of the API package
 * (installed, nested or bundled) finds the global tracer provider and context manager through the same
 * symbol-keyed object on `globalThis`, so the layer needs no dependency on the package itself.
 */

export const GLOBAL_KEY = Symbol.for('opentelemetry.js.api.1');
/** Key under which the API stores the active span in a context (`createContextKey` uses `Symbol.for`). */
export const SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN');

export type OtelAttributeValue = string | number | boolean | Array<string | number | boolean | null | undefined>;
export type OtelAttributes = Record<string, OtelAttributeValue | undefined>;
export type HrTime = [number, number];
export type TimeInput = HrTime | number | Date;

export interface Context {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): Context;
  deleteValue(key: symbol): Context;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}

export interface SpanOptions {
  kind?: number;
  attributes?: OtelAttributes;
  links?: unknown[];
  startTime?: TimeInput;
  root?: boolean;
}

export interface ContextManager {
  active(): Context;
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(context: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F>;
  bind<T>(context: Context, target: T): T;
  enable(): this;
  disable(): this;
}

export interface GlobalApi {
  readonly version: string;
  trace?: unknown;
  context?: ContextManager;
  [key: string]: unknown;
}

export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
