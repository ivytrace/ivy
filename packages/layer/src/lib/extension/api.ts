import http from 'node:http';

export interface ExtensionEvent {
  eventType: 'INVOKE' | 'SHUTDOWN';
  deadlineMs: number;
  requestId?: string;
  shutdownReason?: string;
}

function request(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) return Promise.reject(new Error('AWS_LAMBDA_RUNTIME_API is not set'));
  const [hostname, port] = api.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port: Number(port || 80), path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function register(name: string, events: string[]): Promise<string> {
  const res = await request('POST', '/2020-01-01/extension/register', { 'Lambda-Extension-Name': name, 'content-type': 'application/json' }, JSON.stringify({ events }));
  const id = res.headers['lambda-extension-identifier'];
  if (res.status !== 200 || typeof id !== 'string') throw new Error(`register failed: HTTP ${res.status} ${res.body}`);
  return id;
}

export async function nextEvent(id: string): Promise<ExtensionEvent> {
  const res = await request('GET', '/2020-01-01/extension/event/next', { 'Lambda-Extension-Identifier': id });
  if (res.status !== 200) throw new Error(`next failed: HTTP ${res.status} ${res.body}`);
  return JSON.parse(res.body);
}

export async function initError(id: string, message: string): Promise<void> {
  await request('POST', '/2020-01-01/extension/init/error', { 'Lambda-Extension-Identifier': id, 'Lambda-Extension-Function-Error-Type': 'Extension.InitError' }, JSON.stringify({ errorMessage: message, errorType: 'Extension.InitError' })).catch(() => {});
}
