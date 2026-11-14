type Listener = (request: string, exports: any) => void;

const listeners: Listener[] = [];

/**
 * Calls `listener` after every CommonJS `require` (builtins included). All instrumentations share
 * one `Module._load` wrapper.
 */
export function onRequire(listener: Listener): void {
  if (!listeners.length) {
    const M = process.getBuiltinModule('node:module') as any;
    const load = M._load;
    M._load = function (this: unknown, request: string, ...rest: unknown[]) {
      const exports = load.call(this, request, ...rest);
      for (const l of listeners) {
        try {
          l(request, exports);
        } catch {
          // instrumentation must never break module loading
        }
      }
      return exports;
    };
  }
  listeners.push(listener);
}
