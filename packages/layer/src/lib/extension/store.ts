import type { Batch } from '../export/queue.js';
import type { OtlpKeyValue, OtlpSpan } from '../export/otlp.js';

interface Entry {
  resource: OtlpKeyValue[];
  spans: Map<string, OtlpSpan>;
  final: boolean;
  waiters: (() => void)[];
}

/**
 * Collects span batches from the in-process tracer per request ID. A later batch for the same
 * request replaces spans with the same ID (a provisional timeout snapshot is superseded by the final one).
 */
export class SpanStore {
  private entries = new Map<string, Entry>();

  add(requestId: string, final: boolean, resource: OtlpKeyValue[], spans: OtlpSpan[]): void {
    let entry = this.entries.get(requestId);
    if (!entry) {
      entry = { resource, spans: new Map(), final: false, waiters: [] };
      this.entries.set(requestId, entry);
    }
    entry.resource = resource;
    for (const span of spans) entry.spans.set(span.spanId, span);
    if (final) {
      entry.final = true;
      entry.waiters.splice(0).forEach((w) => w());
    }
  }

  /** Resolves true once the final batch for `requestId` arrived, or false after `timeoutMs`. */
  waitFor(requestId: string, timeoutMs: number): Promise<boolean> {
    let entry = this.entries.get(requestId);
    if (entry?.final) return Promise.resolve(true);
    if (!entry) {
      entry = { resource: [], spans: new Map(), final: false, waiters: [] };
      this.entries.set(requestId, entry);
    }
    const e = entry;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      e.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Removes and returns everything collected so far. */
  drain(): Batch[] {
    const out: Batch[] = [];
    for (const entry of this.entries.values()) {
      if (entry.spans.size) out.push({ resource: entry.resource, spans: [...entry.spans.values()] });
    }
    this.entries.clear();
    return out;
  }
}
