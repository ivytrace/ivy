import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ExtensionLink, extensionInstalled, sendToExtension } from './client.js';

const batch = { requestId: 'r1', final: true, resource: [], spans: [] };

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('sendToExtension', () => {
  it('retries the connection until an intake that opens late is listening', async () => {
    const port = await freePort();
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200).end('{}');
      });
    });
    setTimeout(() => server.listen(port, '127.0.0.1'), 120);
    try {
      expect(await sendToExtension(port, batch, 1000, [50, 100, 200])).toBe(true);
      expect(JSON.parse(received[0]).requestId).toBe('r1');
    } finally {
      server.close();
    }
  });

  it('gives up after the retries when nothing listens', async () => {
    const port = await freePort();
    const started = Date.now();
    expect(await sendToExtension(port, batch, 1000, [10, 10])).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('ExtensionLink', () => {
  it('keeps sending to an installed extension after a failed hello and repeats the hello at the first invocation', async () => {
    const hellos: boolean[] = [false, true];
    let calls = 0;
    const link = new ExtensionLink({ port: 1, expected: true, hello: async () => hellos[calls++] });
    expect(await link.viaExtension).toBe(true);
    link.onInvocationStart();
    link.onInvocationStart();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it('exports directly when no extension is installed and the hello fails', async () => {
    let calls = 0;
    const link = new ExtensionLink({ port: 1, expected: false, hello: async () => (calls++, false) });
    expect(await link.viaExtension).toBe(false);
    link.onInvocationStart();
    expect(calls).toBe(1);
  });

  it('does not repeat a hello that succeeded', async () => {
    let calls = 0;
    const link = new ExtensionLink({ port: 1, expected: true, hello: async () => (calls++, true) });
    expect(await link.viaExtension).toBe(true);
    link.onInvocationStart();
    expect(calls).toBe(1);
  });
});

describe('extensionInstalled', () => {
  it('needs the exec wrapper and the extension file', () => {
    const yes = () => true;
    expect(extensionInstalled({ AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper' }, yes)).toBe(true);
    expect(extensionInstalled({ AWS_LAMBDA_EXEC_WRAPPER: '/opt/ivy-wrapper' }, () => false)).toBe(false);
    expect(extensionInstalled({}, yes)).toBe(false);
  });
});
