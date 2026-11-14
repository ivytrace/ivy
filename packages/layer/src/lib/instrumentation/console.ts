import { format } from 'node:util';
import type { Tracer } from '../tracer/tracer.js';

const SEVERITY: Record<string, string> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  trace: 'debug',
};

export function instrumentConsole(tracer: Tracer): void {
  for (const [method, severity] of Object.entries(SEVERITY)) {
    const original = (console as any)[method];
    if (typeof original !== 'function') continue;
    (console as any)[method] = function (this: unknown, ...args: unknown[]) {
      if (tracer.active) {
        try {
          tracer.addLog(severity, format(...args));
        } catch {
          // never interfere with logging
        }
      }
      return original.apply(this, args);
    };
  }
}
