import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { instrumentConsole } from '../instrumentation/console.js';
import { instrumentFetch } from '../instrumentation/fetch.js';
import { attrs } from '../otel-bridge/test-utils.js';
import { Tracer, type SpanBatch } from '../tracer/tracer.js';
import { instrumentServer } from './server.js';

const batches: SpanBatch[] = [];
const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://ingest.invalid' }), (b) => batches.push(b));
tracer.enableConcurrency();
instrumentServer(tracer);
instrumentFetch(tracer);
instrumentConsole(tracer);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });

let app: Server;
let upstream: Server;
let base = '';
let upstreamUrl = '';

beforeAll(async () => {
  upstream = createServer((req, res) => res.end(`upstream ${req.url}`));
  app = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/work') {
      const name = url.searchParams.get('name');
      console.log(`start ${name}`);
      await sleep(Number(url.searchParams.get('wait')));
      await fetch(`${upstreamUrl}/${name}`).then((r) => r.text());
      console.log(`done ${name}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name }));
    } else if (url.pathname === '/echo') {
      // Listener-style body reading, as body parsers do: runs in the request's 'data'/'end' events.
      req.on('data', () => {});
      req.on('end', () => {
        console.log('body read');
        res.statusCode = 502;
        res.end('bad gateway');
      });
    } else if (url.pathname === '/hang') {
      await readBody(req);
      res.write('partial');
    }
  });
  await Promise.all([app, upstream].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => {
  app.closeAllConnections();
  app.close();
  upstream.close();
});

function call(path: string, requestId: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { 'lambda-web-request-id': requestId, 'lambda-web-endpoint-name': 'checkout', ...init.headers } });
}

async function spansOf(requestId: string) {
  for (let i = 0; i < 50 && !batches.some((b) => b.requestId === requestId && b.final); i++) await sleep(10);
  const [root, ...children] = batches.filter((b) => b.requestId === requestId).flatMap((b) => b.spans);
  return { root, rootAttrs: attrs(root), children, resource: attrs({ attributes: batches.find((b) => b.requestId === requestId)!.resource }) };
}

describe('instrumentServer', () => {
  it('records each of several concurrent requests as its own invocation', async () => {
    // b starts after a and finishes first, so their calls and logs interleave.
    await Promise.all([call('/work?name=a&wait=60', 'req-a'), sleep(10).then(() => call('/work?name=b&wait=10', 'req-b'))]);
    for (const name of ['a', 'b']) {
      const { root, rootAttrs, children, resource } = await spansOf(`req-${name}`);
      expect(rootAttrs).toMatchObject({
        'ivy.invocation': true,
        'faas.invocation_id': `req-${name}`,
        'faas.trigger': 'http',
        'ivy.trigger.source': 'aws:lambda-web',
        'aws.lambda.web.endpoint': 'checkout',
        'http.request.method': 'GET',
        'url.path': '/work',
        'http.response.status_code': 200,
      });
      expect(root.name).toBe('checkout');
      expect(resource['faas.name']).toBe('checkout');
      expect(JSON.parse(rootAttrs['ivy.payload.response'] as string)).toMatchObject({ statusCode: 200, body: { name } });
      expect(root.events.map((e) => attrs(e)['log.message'])).toEqual([`start ${name}`, `done ${name}`]);
      expect(children).toHaveLength(1);
      expect(attrs(children[0])['url.full']).toBe(`${upstreamUrl}/${name}`);
      expect(children[0].parentSpanId).toBe(root.spanId);
    }
    expect((await spansOf('req-a')).rootAttrs['faas.coldstart']).toBe(true);
    expect((await spansOf('req-b')).rootAttrs['faas.coldstart']).toBe(false);
  });

  it('keeps the context in request events, records bodies and fails on 5xx', async () => {
    const res = await call('/echo?token=abc', 'req-echo', { method: 'POST', body: '{"user":"ada","password":"x"}', headers: { 'content-type': 'application/json', authorization: 'Bearer y' } });
    expect(res.status).toBe(502);
    const { root, rootAttrs } = await spansOf('req-echo');
    expect(root.status).toEqual({ code: 2, message: 'HTTP 502' });
    expect(root.events.map((e) => attrs(e)['log.message'])).toEqual(['body read']);
    const request = JSON.parse(rootAttrs['ivy.payload.request'] as string);
    expect(request).toMatchObject({ method: 'POST', url: '/echo?token=%5Bredacted%5D', body: { user: 'ada', password: '[redacted]' } });
    expect(request.headers.authorization).toBe('[redacted]');
    expect(JSON.parse(rootAttrs['ivy.payload.response'] as string)).toMatchObject({ statusCode: 502, body: 'bad gateway' });
  });

  it('records a connection closed before the response finished as a failure', async () => {
    await new Promise<void>((resolve) => {
      const req = request(`${base}/hang`, { method: 'POST', headers: { 'lambda-web-request-id': 'req-hang' } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.end('x');
    });
    const { root, rootAttrs } = await spansOf('req-hang');
    expect(rootAttrs['error.type']).toBe('ConnectionClosed');
    expect(root.status.code).toBe(2);
  });

  it('leaves code outside requests untraced', () => {
    expect(tracer.active).toBeUndefined();
  });
});
