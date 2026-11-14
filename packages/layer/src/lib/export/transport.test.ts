import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRetryAfter, postWithRetry } from './transport.js';

let responses: { status: number; headers?: Record<string, string> }[] = [];
let hits = 0;
let server: http.Server;
let url = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      const next = responses.shift() ?? { status: 200 };
      res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
});

beforeEach(() => {
  responses = [];
  hits = 0;
});

afterAll(() => server.close());

const send = () => postWithRetry(url, '{}', { timeoutMs: 1000, budgetMs: 2000, keepAlive: false });

describe('postWithRetry', () => {
  it('stops at once on 429 with Retry-After and passes the delay on', async () => {
    responses = [{ status: 429, headers: { 'retry-after': '300' } }];
    expect(await send()).toEqual({ ok: false, retryAfterMs: 300_000 });
    expect(hits).toBe(1);
  });

  it('retries a 429 without Retry-After within the budget', async () => {
    responses = [{ status: 429 }, { status: 200 }];
    expect(await send()).toEqual({ ok: true });
    expect(hits).toBe(2);
  });

  it('does not retry other 4xx', async () => {
    responses = [{ status: 401 }];
    expect(await send()).toEqual({ ok: false });
    expect(hits).toBe(1);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
