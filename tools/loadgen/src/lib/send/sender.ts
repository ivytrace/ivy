import { encodeTraces } from '../otlp/encode.js';
import type { GeneratedInvocation } from '../trace/generate.js';

export async function sendBatch(endpoint: string, key: string, batch: GeneratedInvocation[]): Promise<void> {
  const url = `${endpoint.replace(/\/$/, '')}/v1/traces`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(encodeTraces(batch)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Collector responded ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
}
