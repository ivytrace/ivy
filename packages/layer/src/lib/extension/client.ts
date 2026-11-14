import type { SpanBatch } from '../tracer/tracer.js';
import { post } from '../export/transport.js';

const base = (port: number) => `http://127.0.0.1:${port}`;

/** Announces the in-process tracer to the extension, so it waits for spans before each `/next`. */
export async function helloExtension(port: number, timeoutMs = 300): Promise<boolean> {
  try {
    const res = await post(`${base(port)}/hello`, JSON.stringify({ pid: process.pid }), { timeoutMs, keepAlive: false });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function sendToExtension(port: number, batch: SpanBatch, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await post(`${base(port)}/spans`, JSON.stringify(batch), { timeoutMs, keepAlive: false });
    return res.status === 200;
  } catch {
    return false;
  }
}
