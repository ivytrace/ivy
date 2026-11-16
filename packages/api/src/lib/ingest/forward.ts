import http from 'node:http';
import https from 'node:https';

export interface Forwarded {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256 }),
};

/** POSTs `body` to `url` over a keep-alive connection and buffers the response. */
export function forward(url: string, headers: Record<string, string>, body: Buffer, timeoutMs: number): Promise<Forwarded> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: 'POST',
        agent: agents[target.protocol as keyof typeof agents],
        headers: { ...headers, 'content-length': body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
}
