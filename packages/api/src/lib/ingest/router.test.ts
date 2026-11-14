import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultProjectId, hashKey } from '../tenancy/ids.js';
import type { KeyMatch } from '../tenancy/store.js';
import { FailureLimiter } from './failure-limiter.js';
import { KeyCache } from './key-cache.js';
import type { Limits } from '../limits/limits.js';
import { effectiveLimits } from '../limits/limits.js';
import { QuotaGate } from '../limits/quota-gate.js';
import { jsonInvocations, jsonRequest, protobufInvocations, protobufRequest } from './otlp-fixtures.js';
import { createIngestHandler } from './router.js';
import { UsageCounters } from './usage.js';

interface Received {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const project = (id: string, archived = false) => ({ tenant_id: 'ten_a', id, slug: id, name: id, archived, created_at: 0 });
const tenantA = { id: 'ten_a', slug: 'a', name: 'A', shard_id: 'shard-1', created_at: 0 };
const KEYS: Record<string, KeyMatch> = {
  [hashKey('good-key')]: {
    key: { id: 'key_1', tenant_id: 'ten_a', project_id: 'prj_staging' } as KeyMatch['key'],
    tenant: tenantA,
    project: project('prj_staging'),
  },
  // A key from before projects: no project_id, and the default project has no row yet.
  [hashKey('old-key')]: { key: { id: 'key_2', tenant_id: 'ten_a', project_id: '' } as KeyMatch['key'], tenant: tenantA, project: null },
  [hashKey('archived-key')]: {
    key: { id: 'key_3', tenant_id: 'ten_a', project_id: 'prj_old' } as KeyMatch['key'],
    tenant: tenantA,
    project: project('prj_old', true),
  },
  [hashKey('orphan-key')]: { key: { id: 'key_4', tenant_id: 'ten_a', project_id: 'prj_gone' } as KeyMatch['key'], tenant: tenantA, project: null },
};

let received: Received[] = [];
let collectorStatus = 200;
let lookupFails = false;
let lookups = 0;
let collector: http.Server;
let router: http.Server;
let collectorUrl = '';
let routerUrl = '';
let usage: UsageCounters;
let limits: Record<string, Limits> = {};
let storedTraces: Record<string, number> = {};

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  collector = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(collectorStatus, { 'content-type': 'application/json' }).end('{}');
    });
  });
  collectorUrl = await listen(collector);
});

beforeEach(async () => {
  received = [];
  collectorStatus = 200;
  lookupFails = false;
  lookups = 0;
  usage = new UsageCounters();
  limits = {};
  storedTraces = {};
  router?.close();
  router = http.createServer(
    createIngestHandler({
      keys: new KeyCache({
        lookup: async (hash) => {
          lookups++;
          if (lookupFails) throw new Error('control db down');
          return KEYS[hash] ?? null;
        },
      }),
      limiter: new FailureLimiter(3),
      usage,
      quota: new QuotaGate({
        load: async (tenant) => ({ limits: effectiveLimits(limits[tenant] ?? null), used: storedTraces[tenant] ?? 0 }),
        upgradeUrl: 'https://ivy.example/settings/usage',
      }),
      collectorUrl: (shard) => (shard === 'shard-1' ? collectorUrl : 'http://127.0.0.1:1'),
      collectorToken: 'internal',
      maxBodyBytes: 64 * 1024,
      maxDecodedBytes: 256 * 1024,
    }),
  );
  routerUrl = await listen(router);
});

afterAll(() => {
  router?.close();
  collector.close();
});

const post = (body: Buffer | string, headers: Record<string, string>, path = '/v1/traces') =>
  fetch(routerUrl + path, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body) });

const JSON_BODY = JSON.stringify(jsonRequest(3));

describe('ingest router', () => {
  it('sends keys from before projects to the default project, and refuses archived or missing projects', async () => {
    const ok = await post(JSON_BODY, { authorization: 'Bearer old-key', 'content-type': 'application/json' });
    expect(ok.status).toBe(200);
    expect(received[0].headers['x-ivy-project']).toBe(defaultProjectId('ten_a'));
    expect((await post(JSON_BODY, { authorization: 'Bearer archived-key', 'content-type': 'application/json' })).status).toBe(401);
    expect((await post(JSON_BODY, { authorization: 'Bearer orphan-key', 'content-type': 'application/json' })).status).toBe(401);
    expect(received).toHaveLength(1);
  });

  it('forwards an authenticated request unchanged with the tenant header and the internal token', async () => {
    const body = protobufRequest([[2]]);
    const res = await post(body, { authorization: 'Bearer good-key', 'content-type': 'application/x-protobuf' });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body.equals(body)).toBe(true);
    expect(received[0].headers['x-ivy-tenant']).toBe('ten_a');
    expect(received[0].headers['x-ivy-project']).toBe('prj_staging');
    expect(received[0].headers.authorization).toBe('Bearer internal');
    expect(received[0].headers['content-type']).toBe('application/x-protobuf');
    expect(usage.snapshot()).toEqual({ ten_a: { requests: 1, spans: 2, bytes: body.length } });
  });

  it('passes gzip bodies through compressed, and accepts x-api-key', async () => {
    const gz = gzipSync(JSON_BODY);
    const res = await post(gz, { 'x-api-key': 'good-key', 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(received[0].headers['content-encoding']).toBe('gzip');
    expect(received[0].body.equals(gz)).toBe(true);
    expect(usage.snapshot().ten_a.spans).toBe(3);
  });

  it('rejects missing and invalid keys with 401 and caches the miss', async () => {
    expect((await post(JSON_BODY, { 'content-type': 'application/json' })).status).toBe(401);
    const bad = await post(JSON_BODY, { authorization: 'Bearer nope', 'content-type': 'application/json' });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ code: 16, message: 'Invalid API key' });
    await post(JSON_BODY, { authorization: 'Bearer nope', 'content-type': 'application/json' });
    expect(lookups).toBe(1);
    expect(received).toHaveLength(0);
  });

  it('rate-limits invalid keys per IP, but not keys already known to be valid', async () => {
    await post(JSON_BODY, { authorization: 'Bearer good-key', 'content-type': 'application/json' });
    for (let i = 0; i < 3; i++) await post(JSON_BODY, { authorization: `Bearer bad-${i}`, 'content-type': 'application/json' });
    const limited = await post(JSON_BODY, { authorization: 'Bearer bad-x', 'content-type': 'application/json' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post(JSON_BODY, { authorization: 'Bearer good-key', 'content-type': 'application/json' })).status).toBe(200);
  });

  it('enforces the body size limit, compressed and decompressed', async () => {
    const big = Buffer.alloc(100 * 1024, 'a');
    expect((await post(big, { authorization: 'Bearer good-key', 'content-type': 'application/json' })).status).toBe(413);
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 'a'));
    const res = await post(bomb, { authorization: 'Bearer good-key', 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('answers 400 for malformed bodies and 415 for other content types', async () => {
    expect((await post('{', { authorization: 'Bearer good-key', 'content-type': 'application/json' })).status).toBe(400);
    expect((await post('x', { authorization: 'Bearer good-key', 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('answers 404 for logs and metrics', async () => {
    const res = await post(JSON_BODY, { authorization: 'Bearer good-key', 'content-type': 'application/json' }, '/v1/logs');
    expect(res.status).toBe(404);
    expect((await post(JSON_BODY, { authorization: 'Bearer good-key', 'content-type': 'application/json' }, '/v1/metrics')).status).toBe(404);
  });

  it('answers 503 with Retry-After when the collector is down or the key lookup fails', async () => {
    KEYS[hashKey('other-shard')] = { ...KEYS[hashKey('good-key')], tenant: { id: 'ten_b', slug: 'b', name: 'B', shard_id: 'shard-2', created_at: 0 } };
    const down = await post(JSON_BODY, { authorization: 'Bearer other-shard', 'content-type': 'application/json' });
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('5');
    expect(usage.snapshot()).toEqual({});

    lookupFails = true;
    const res = await post(JSON_BODY, { authorization: 'Bearer unknown', 'content-type': 'application/json' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('passes collector backpressure through, and maps collector auth errors to 503', async () => {
    collectorStatus = 429;
    const res = await post(JSON_BODY, { authorization: 'Bearer good-key', 'content-type': 'application/json' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    collectorStatus = 401;
    expect((await post(JSON_BODY, { authorization: 'Bearer good-key', 'content-type': 'application/json' })).status).toBe(503);
    expect(usage.snapshot()).toEqual({});
  });

  describe('monthly trace quota', () => {
    const headers = { authorization: 'Bearer good-key', 'content-type': 'application/json' };
    const invocations = (n: number) => JSON.stringify(jsonInvocations(n, 2));

    it('is unlimited without limits', async () => {
      storedTraces.ten_a = 10_000_000;
      expect((await post(invocations(5), headers)).status).toBe(200);
    });

    it('blocks at the quota with block: 429, Retry-After and an upgrade message, nothing forwarded', async () => {
      limits.ten_a = { plan: 'Free', monthly_trace_quota: 100, over_quota: 'block' };
      storedTraces.ten_a = 100;
      const res = await post(invocations(1), headers);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      const body = (await res.json()) as { code: number; message: string };
      expect(body.code).toBe(8);
      expect(body.message).toMatch(/Monthly trace quota reached \(100 traces on the Free plan\).*Upgrade at https:\/\/ivy\.example/);
      expect(received).toHaveLength(0);
    });

    it('counts accepted invocations towards the quota until the next refresh', async () => {
      limits.ten_a = { plan: 'Free', monthly_trace_quota: 10, over_quota: 'block' };
      storedTraces.ten_a = 4;
      expect((await post(invocations(6), headers)).status).toBe(200);
      const blocked = await post(protobufInvocations(1), { authorization: 'Bearer good-key', 'content-type': 'application/x-protobuf' });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('content-type')).toBe('application/x-protobuf');
      expect(received).toHaveLength(1);
    });

    it('never blocks with allow', async () => {
      limits.ten_a = { plan: 'Pro', monthly_trace_quota: 100, over_quota: 'allow' };
      storedTraces.ten_a = 5_000;
      expect((await post(invocations(3), headers)).status).toBe(200);
    });
  });
});
