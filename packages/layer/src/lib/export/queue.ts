import { buildExportRequest, type OtlpKeyValue, type OtlpSpan } from './otlp.js';
import { postWithRetry, type SendResult } from './transport.js';

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
  send?: (body: string, budgetMs: number) => Promise<boolean | SendResult>;
  now?: () => number;
}

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Longest server-requested pause honoured (an environment rarely lives longer). */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** Bounded span queue with retry/backoff and a dropped-span counter reported on the next batch. */
export class ExportQueue {
  private batches: Batch[] = [];
  private queued = 0;
  private flushing: Promise<void> | undefined;
  dropped = 0;
  private nextAttemptAt = 0;
  private backoffMs = 0;
  /** Until when the server asked us not to send (Retry-After); respected even by forced flushes. */
  private serverPauseUntil = 0;

  constructor(private opts: QueueOptions) {}

  get size(): number {
    return this.queued;
  }

  /** Batches waiting; the tracer hands over one per invocation span plus one per chunk of children. */
  get pending(): number {
    return this.batches.length;
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
    if (now() < this.serverPauseUntil) return;
    if (!force && now() < this.nextAttemptAt) return;
    const maxPerRequest = this.opts.maxSpansPerRequest ?? 500;
    while (this.batches.length && deadline - now() > 50) {
      const taken: Batch[] = [];
      let count = 0;
      // Invocation spans go in requests of their own, so a failing chunk of children never takes one along.
      const rootsOnly = isRootBatch(this.batches[0]);
      while (
        this.batches.length &&
        (count === 0 || (count + this.batches[0].spans.length <= maxPerRequest && isRootBatch(this.batches[0]) === rootsOnly))
      ) {
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
      const sent = await this.send(body, deadline - now());
      const { ok, retryAfterMs } = typeof sent === 'boolean' ? { ok: sent, retryAfterMs: undefined } : sent;
      if (ok) {
        this.dropped -= dropped;
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
      } else {
        this.drop(count, retryAfterMs === undefined ? 'export failed' : `rejected, retry after ${Math.round(retryAfterMs / 1000)} s`);
        this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : MIN_BACKOFF_MS);
        this.nextAttemptAt = now() + this.backoffMs;
        if (retryAfterMs !== undefined) {
          this.serverPauseUntil = now() + Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
          this.nextAttemptAt = Math.max(this.nextAttemptAt, this.serverPauseUntil);
        }
        return;
      }
    }
  }

  private send(body: string, budgetMs: number): Promise<boolean | SendResult> {
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

const isRootBatch = (b: Batch) =>
  b.spans.length > 0 && b.spans.every((s) => s.attributes.some((a) => a.key === 'ivy.invocation' && 'boolValue' in a.value && a.value.boolValue));
