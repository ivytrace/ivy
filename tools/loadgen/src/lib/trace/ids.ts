import { hex } from './random.js';

/** 128-bit trace ID whose first 8 hex chars are the start time in unix seconds. */
export function traceId(startMs: number): string {
  return Math.floor(startMs / 1000).toString(16).padStart(8, '0') + hex(24);
}

export function spanId(): string {
  return hex(16);
}
