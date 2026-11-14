import { buildExportRequest, type OtlpKeyValue, type OtlpSpan } from './otlp.js';
import { postWithRetry } from './transport.js';

export interface Batch {
  resource: OtlpKeyValue[];
  spans: OtlpSpan[];
}

export interface QueueOptions {
  url: string;
  apiKey?: string;
  maxQueueSpans: number;
  exportTimeoutMs: number;
  maxSpansPerRequest?: number;
  log?: (msg: string) => void;
  send?: (body: string, budgetMs: number) => Promise<boolean>;
  now?: () => number;
}

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Bounded span queue with retry/backoff and a dropped-span counter reported on the next batch. */
export class ExportQueue {
  private batches: Batch[] = [];
  private queued = 0;
  private flushing: Promise<void> | undefined;
  dropped = 0;
  private nextAttemptAt = 0;
  private backoffMs = 0;

  constructor(private opts: QueueOptions) {}

  get size(): number {
    return this.queued;
  }

  add(batch: Batch): void {
    if (!batch.spans.length) return;
    while (this.batches.length && this.queued + batch.spans.length > this.opts.maxQueueSpans) {
      const old = this.batches.shift()!;
      this.queued -= old.spans.length;
      this.drop(old.spans.length, 'queue full');
    }
    if (batch.spans.length > this.opts.maxQueueSpans) {
      this.drop(batch.spans.length, 'batch larger than queue');
      return;
    }
    this.batches.push(batch);
    this.queued += batch.spans.length;
  }

  private drop(n: number, reason: string) {
    this.dropped += n;
    this.opts.log?.(`dropped ${n} spans (${reason}); ${this.dropped} dropped since last successful export`);
  }

  /** Exports queued spans within `budgetMs`. `force` ignores the failure backoff (shutdown). */
  flush(budgetMs: number, force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush(budgetMs, force).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async doFlush(budgetMs: number, force: boolean): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const deadline = now() + budgetMs;
    if (!force && now() < this.nextAttemptAt) return;
    const maxPerRequest = this.opts.maxSpansPerRequest ?? 500;
    while (this.batches.length && deadline - now() > 50) {
      const taken: Batch[] = [];
      let count = 0;
      while (this.batches.length && (count === 0 || count + this.batches[0].spans.length <= maxPerRequest)) {
        const b = this.batches.shift()!;
        taken.push(b);
        count += b.spans.length;
      }
      this.queued -= count;
      const dropped = this.dropped;
      if (dropped > 0) {
        const first = taken[0].spans[0];
        first.attributes = first.attributes.filter((a) => a.key !== 'ivy.dropped_spans');
        first.attributes.push({ key: 'ivy.dropped_spans', value: { intValue: String(dropped) } });
      }
      const body = JSON.stringify(buildExportRequest(taken));
      const ok = await this.send(body, deadline - now());
      if (ok) {
        this.dropped -= dropped;
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
      } else {
        this.drop(count, 'export failed');
        this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : MIN_BACKOFF_MS);
        this.nextAttemptAt = now() + this.backoffMs;
        return;
      }
    }
  }

  private send(body: string, budgetMs: number): Promise<boolean> {
    if (this.opts.send) return this.opts.send(body, budgetMs);
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    return postWithRetry(this.opts.url, body, {
      headers,
      gzip: true,
      timeoutMs: this.opts.exportTimeoutMs,
      budgetMs,
      onError: this.opts.log,
    });
  }
}
