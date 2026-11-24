import type { Config } from '../config/config.js';
import { ExportQueue } from '../export/queue.js';
import type { SpanBatch } from '../tracer/tracer.js';

/** How long finished requests are gathered before an export, so a busy environment sends fewer, larger requests. */
const FLUSH_DELAY_MS = 100;
/** Lambda allows 1 s between SIGTERM and the end of the environment. */
const SHUTDOWN_BUDGET_MS = 800;

/**
 * Export for Web Functions, which have no extension: the process keeps running between requests, so spans are
 * exported from it shortly after each request finishes, and whatever is left when Lambda sends SIGTERM.
 */
export function createWebExporter(config: Config, log: (msg: string) => void, queue = defaultQueue(config, log)) {
  let timer: NodeJS.Timeout | undefined;

  const flush = () => {
    timer = undefined;
    queue
      .flush(config.flushBudgetMaxMs)
      .catch(() => {})
      .finally(() => {
        if (queue.pending && !timer) schedule();
      });
  };
  const schedule = () => {
    timer = setTimeout(flush, FLUSH_DELAY_MS);
    timer.unref();
  };

  const onSigterm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const alone = process.listenerCount('SIGTERM') === 1;
    queue
      .flush(SHUTDOWN_BUDGET_MS, true)
      .catch(() => {})
      .finally(() => {
        // Without other listeners Node would have ended the process on SIGTERM; do that now.
        if (alone) {
          process.removeListener('SIGTERM', onSigterm);
          process.kill(process.pid, 'SIGTERM');
        }
      });
  };
  process.prependListener('SIGTERM', onSigterm);

  return {
    sink(batch: SpanBatch) {
      queue.add(batch);
      if (batch.final && !timer) schedule();
    },
    queue,
  };
}

function defaultQueue(config: Config, log: (msg: string) => void): ExportQueue {
  return new ExportQueue({
    url: config.tracesUrl!,
    apiKey: config.apiKey,
    maxQueueSpans: config.maxQueueSpans,
    exportTimeoutMs: config.exportTimeoutMs,
    maxSpansPerRequest: config.exportChunkSpans,
    log,
  });
}
