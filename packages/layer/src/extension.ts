import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './lib/config/config.js';
import { nextEvent, register } from './lib/extension/api.js';
import { SpanStore } from './lib/extension/store.js';
import { ExportQueue } from './lib/export/queue.js';

const config = loadConfig();
const name = path.basename(process.argv[1] ?? 'ivy-extension');
const log = (msg: string) => console.error(`[ivy-extension] ${msg}`);
const debug = (msg: string) => config.debug && log(msg);

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const WAIT_GRACE_MS = 200;
const SHUTDOWN_BUDGET_MS = 1500;

const store = new SpanStore();
let tracerAttached = false;

function startServer(): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on('end', () => {
      try {
        if (req.method === 'POST' && req.url === '/hello') {
          tracerAttached = true;
        } else if (req.method === 'POST' && req.url === '/spans' && size <= MAX_BODY_BYTES) {
          const batch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          store.add(String(batch.requestId), !!batch.final, batch.resource ?? [], Array.isArray(batch.spans) ? batch.spans : []);
        } else {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch (e) {
        res.writeHead(400).end(String((e as Error).message));
      }
    });
  });
  server.keepAliveTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.extensionPort, '127.0.0.1', () => resolve());
  });
}

async function main() {
  if (!config.enabled) {
    const id = await register(name, []);
    debug('IVY_ENDPOINT not set; idle');
    for (;;) await nextEvent(id);
  }

  const queue = new ExportQueue({
    url: config.tracesUrl!,
    apiKey: config.apiKey,
    maxQueueSpans: config.maxQueueSpans,
    exportTimeoutMs: config.exportTimeoutMs,
    log,
  });

  try {
    await startServer();
  } catch (e) {
    log(`could not listen on 127.0.0.1:${config.extensionPort}: ${(e as Error).message}`);
  }
  const id = await register(name, ['INVOKE', 'SHUTDOWN']);
  debug('registered');

  for (;;) {
    let event;
    try {
      event = await nextEvent(id);
    } catch (e) {
      log(`next failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    if (event.eventType === 'SHUTDOWN') {
      for (const b of store.drain()) queue.add(b);
      const budget = Math.min(SHUTDOWN_BUDGET_MS, event.deadlineMs - Date.now() - 100);
      if (queue.size && budget > 50) await queue.flush(budget, true).catch(() => {});
      debug(`shutdown (${event.shutdownReason ?? 'unknown'})`);
      process.exit(0);
    }
    if (tracerAttached && event.requestId) {
      const waitMs = event.deadlineMs - Date.now() + WAIT_GRACE_MS;
      const ok = await store.waitFor(event.requestId, waitMs);
      if (!ok) debug(`no final spans for ${event.requestId}`);
    }
    for (const b of store.drain()) queue.add(b);
    if (queue.size) await queue.flush(config.flushBudgetMs).catch((e) => log(`flush error: ${(e as Error).message}`));
  }
}

process.on('uncaughtException', (e) => log(`uncaught: ${e?.message}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.message}`));

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
