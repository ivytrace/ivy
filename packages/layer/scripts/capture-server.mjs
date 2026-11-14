// Tiny OTLP/HTTP JSON capture server plus fake upstreams used by the example handlers.
//   POST /v1/traces       records OTLP export requests (gzip supported)
//   *    /echo            echoes the request as JSON
//   POST /dynamodb        fake DynamoDB endpoint (200, returns an item)
//   POST /dynamodb-fail   fake DynamoDB endpoint (400 ResourceNotFoundException)
//   POST /llm/v1/chat/completions  fake model endpoint (16 KB answer, 1200 → 80 tokens)
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

export function startCaptureServer({ port = 4399, apiKey } = {}) {
  const exports = [];
  const listeners = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
      const text = body.toString('utf8');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/v1/traces') {
        if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
          res.writeHead(401).end('bad api key');
          return;
        }
        const payload = JSON.parse(text);
        exports.push({ receivedAt: Date.now(), headers: req.headers, payload });
        listeners.forEach((l) => l());
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } else if (url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc' });
        res.end(JSON.stringify({ method: req.method, query: Object.fromEntries(url.searchParams), body: text || null }));
      } else if (url.pathname.replace(/\/$/, '') === '/dynamodb') {
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': 'FAKE-REQ-1' });
        res.end(JSON.stringify({ Item: { id: { S: '42' }, name: { S: 'Ada' }, token: { S: 'should-be-redacted' } } }));
      } else if (url.pathname === '/llm/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const content = 'Category: furniture. '.repeat(780).slice(0, 16_000);
        res.end(JSON.stringify({ id: 'chatcmpl-fake', model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1200, completion_tokens: 80 } }));
      } else if (url.pathname.replace(/\/$/, '') === '/dynamodb-fail') {
        res.writeHead(400, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': 'FAKE-REQ-2' });
        res.end(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException', message: 'Requested resource not found' }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () =>
      resolve({
        exports,
        spans: () =>
          exports.flatMap((e) =>
            e.payload.resourceSpans.flatMap((rs) =>
              rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, resource: rs.resource, receivedAt: e.receivedAt }))),
            ),
          ),
        waitFor: (predicate, timeoutMs) =>
          new Promise((done) => {
            const check = () => {
              if (predicate()) {
                listeners.delete(check);
                clearTimeout(timer);
                done(true);
              }
            };
            const timer = setTimeout(() => {
              listeners.delete(check);
              done(false);
            }, timeoutMs);
            listeners.add(check);
            check();
          }),
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4399);
  const s = await startCaptureServer({ port });
  console.log(`capture server on :${port}`);
  setInterval(() => {}, 1 << 30);
  let seen = 0;
  setInterval(() => {
    for (const e of s.exports.slice(seen)) console.log(JSON.stringify(e.payload, null, 2));
    seen = s.exports.length;
  }, 500);
}
