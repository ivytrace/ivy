import { AsyncLocalStorage } from 'node:async_hooks';
import { GLOBAL_KEY, type Context, type ContextManager, type GlobalApi } from './api.js';

class BaseContext implements Context {
  private readonly values: Map<symbol, unknown>;

  constructor(parent?: Map<symbol, unknown>) {
    this.values = parent ? new Map(parent) : new Map();
  }

  getValue(key: symbol): unknown {
    return this.values.get(key);
  }

  setValue(key: symbol, value: unknown): Context {
    const next = new BaseContext(this.values);
    next.values.set(key, value);
    return next;
  }

  deleteValue(key: symbol): Context {
    const next = new BaseContext(this.values);
    next.values.delete(key);
    return next;
  }
}

export const ROOT_CONTEXT: Context = new BaseContext();

/**
 * Context manager on `AsyncLocalStorage`, like the SDK's `AsyncLocalStorageContextManager`. The storage
 * is created on first use, so async hooks stay off until something actually starts an active span.
 */
export class AlsContextManager implements ContextManager {
  private storage: AsyncLocalStorage<Context> | undefined;

  active(): Context {
    return this.storage?.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(context: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    this.storage ??= new AsyncLocalStorage();
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.storage.run(context, cb as (...a: A) => ReturnType<F>, ...args);
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const manager = this;
    const fn = target as unknown as (...args: unknown[]) => unknown;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => fn.apply(this, args));
    } as unknown as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage?.disable();
    this.storage = undefined;
    return this;
  }
}

/** The registered global context manager (the app's own, or the bridge's). */
export function globalContextManager(): ContextManager | undefined {
  return ((globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as GlobalApi | undefined)?.context;
}

export function activeContext(): Context {
  return globalContextManager()?.active() ?? ROOT_CONTEXT;
}
