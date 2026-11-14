import { GLOBAL_KEY, type ContextManager, type GlobalApi } from './api.js';

/** Newest `@opentelemetry/api` this was written against; bundled apps get it as the global's version. */
export const DEFAULT_API_VERSION = '1.10.0';
/** The AI SDK pins `@opentelemetry/api` 1.9.x, so a global registered for an older installed copy would hide it. */
const MIN_API_VERSION = '1.9.0';

// Builtins via getBuiltinModule, not ESM imports (see layer.md, "Tracer init").
const fs = () => process.getBuiltinModule('node:fs');
const join = (...parts: string[]) => process.getBuiltinModule('node:path').join(...parts);

const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
};

/**
 * The version written on a global the bridge creates. API copies only use a global whose minor version is
 * at least their own, and only register into one with exactly their version, so the app's installed copy
 * decides (at least 1.9.0); without one (bundled app) it is the newest known release.
 */
export function apiVersion(appRoot: string): string {
  try {
    const pkg = JSON.parse(fs().readFileSync(join(appRoot, 'node_modules/@opentelemetry/api/package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && /^1\.\d+\.\d+$/.test(pkg.version)) {
      return newer(MIN_API_VERSION, pkg.version) ? MIN_API_VERSION : pkg.version;
    }
  } catch {
    // not installed: bundled or not using OpenTelemetry
  }
  return DEFAULT_API_VERSION;
}

/** An installed OpenTelemetry SDK means the app probably registers its own provider while it loads. */
export function hasOwnSdk(appRoot: string): boolean {
  return fs().existsSync(join(appRoot, 'node_modules/@opentelemetry/sdk-trace-base'));
}

export function globalApi(): GlobalApi | undefined {
  return (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as GlobalApi | undefined;
}

/**
 * Registers the tracer provider (and the context manager, if none) the way `trace.setGlobalTracerProvider`
 * does, without loading the API package: on the shared `Symbol.for('opentelemetry.js.api.1')` object.
 * Returns false when a tracer provider is already registered.
 */
export function registerGlobal(provider: unknown, contextManager: ContextManager, version: string): boolean {
  const g = globalThis as Record<symbol, unknown>;
  let api = globalApi();
  if (api?.trace) return false;
  if (!api) {
    api = Object.defineProperty({}, 'version', { value: version, enumerable: true, writable: false, configurable: false }) as GlobalApi;
    g[GLOBAL_KEY] = api;
  }
  api.trace = provider;
  api.context ??= contextManager;
  return true;
}
