import { loadConfig } from './lib/config/config.js';
import { traceWorkerThread } from './lib/workers/child.js';

try {
  traceWorkerThread();
} catch (e) {
  if (loadConfig().debug) console.warn(`[ivy] worker tracing disabled: ${(e as Error).message}`);
}
