import type { SpanBatch } from '../tracer/tracer.js';
import { post } from '../export/transport.js';

const base = (port: number) => `http://127.0.0.1:${port}`;

/**
 * Announces the in-process tracer to the extension, so it waits for spans before each `/next`.
 * Init does not wait for the answer (the extension expects the hello whenever the exec wrapper is
 * configured); the result only decides where spans go. A raw socket because the first
 * `http.request` in a process costs a few ms. Unref'd so it never holds up callback handlers.
 */
export function helloExtension(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let response = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(/^HTTP\/1\.[01] 200 /.test(response));
    };
    const body = JSON.stringify({ pid: process.pid });
    const socket = process.getBuiltinModule('node:net').connect(port, '127.0.0.1');
    const timer = setTimeout(finish, timeoutMs).unref();
    socket.unref();
    socket.setEncoding('latin1');
    // Queued until connected, so the request goes out without waiting for a 'connect' callback.
    socket.write(`POST /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\r\n')) finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

export async function sendToExtension(port: number, batch: SpanBatch, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await post(`${base(port)}/spans`, JSON.stringify(batch), { timeoutMs, keepAlive: false });
    return res.status === 200;
  } catch {
    return false;
  }
}
