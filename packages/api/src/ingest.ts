import http from 'node:http';
import { FailureLimiter } from './lib/ingest/failure-limiter.js';
import { KeyCache } from './lib/ingest/key-cache.js';
import { createIngestHandler } from './lib/ingest/router.js';
import { UsageCounters } from './lib/ingest/usage.js';
import { loadQuotaSnapshot } from './lib/limits/snapshot.js';
import { QuotaGate } from './lib/limits/quota-gate.js';
import { shardConfig, shardConfigs } from './lib/tenancy/shards.js';
import { tenancyStore } from './lib/tenancy/store.js';
import { ensureDefaultTenant } from './lib/tenancy/tenants.js';
import { retry } from './lib/utils/retry.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const num = (name: string, fallback: number) => Number(env(name) ?? fallback);

const collectorToken = env('IVY_COLLECTOR_TOKEN');
if (!collectorToken) {
  console.error('IVY_COLLECTOR_TOKEN is required (the shared secret of the internal collectors)');
  process.exit(1);
}

const port = num('IVY_INGEST_PORT', 4318);
const adminPort = num('IVY_INGEST_ADMIN_PORT', 4320);
const adminHost = env('IVY_INGEST_ADMIN_HOST') ?? '127.0.0.1';
const log = (msg: string) => console.log(`[ingest] ${msg}`);

await retry('bootstrap of the default tenant', () => ensureDefaultTenant());

const usage = new UsageCounters();
const handler = createIngestHandler({
  keys: new KeyCache({ lookup: (hash) => tenancyStore().findKeyByHash(hash) }),
  limiter: new FailureLimiter(num('IVY_INGEST_MAX_KEY_FAILURES', 20)),
  usage,
  quota: new QuotaGate({
    load: loadQuotaSnapshot,
    refreshMs: num('IVY_QUOTA_REFRESH_SECONDS', 60) * 1000,
    recheckSeconds: num('IVY_QUOTA_RETRY_AFTER_SECONDS', 300),
    log,
  }),
  collectorUrl: (shardId) => shardConfig(shardId).collector,
  collectorToken,
  maxBodyBytes: num('IVY_INGEST_MAX_BODY_BYTES', 10 * 1024 * 1024),
  trustProxy: env('IVY_INGEST_TRUST_PROXY') === '1' || env('IVY_INGEST_TRUST_PROXY') === 'true',
  log,
});

const server = http.createServer(handler);
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 30_000;
server.listen(port, () => {
  const shards = [...shardConfigs()].map(([id, s]) => `${id} → ${s.collector}`).join(', ');
  log(`listening on :${port} (OTLP/HTTP /v1/traces; ${shards})`);
});

// Internal only: per-tenant usage since start. Not exposed outside the container/host.
const admin = http.createServer((req, res) => {
  if (req.url === '/stats') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(usage.snapshot()));
  else res.writeHead(404).end();
});
admin.listen(adminPort, adminHost);

setInterval(() => {
  for (const [tenant, u] of Object.entries(usage.deltas())) {
    log(`usage tenant=${tenant} requests=${u.requests} spans=${u.spans} bytes=${u.bytes}`);
  }
}, 60_000).unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    admin.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
