import type { Span, SpanEvent } from '../tracer/span.js';

/**
 * Environment data (`worker_threads.setEnvironmentData`) that tells a new worker the thread that started
 * it collects its spans. The worker removes it again, so workers it starts itself are not traced.
 */
export const TRACED_KEY = 'ivy.workers.traced';

/** What a worker thread posts on its parentPort for the thread that traces it (never seen by the app). */
export interface WorkerBatch {
  ivyWorkerBatch: 1;
  /** The worker's own root span; its direct children become children of the worker span. */
  root: string;
  spans: Span[];
  logs: SpanEvent[];
}

export function isWorkerBatch(value: unknown): value is WorkerBatch {
  return !!value && typeof value === 'object' && (value as WorkerBatch).ivyWorkerBatch === 1;
}
