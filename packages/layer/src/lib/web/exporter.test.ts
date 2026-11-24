import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { ExportQueue } from '../export/queue.js';
import type { OtlpSpan } from '../export/otlp.js';
import { createWebExporter } from './exporter.js';

const span = (name: string, invocation = false): OtlpSpan =>
  ({ name, attributes: invocation ? [{ key: 'ivy.invocation', value: { boolValue: true } }] : [] }) as unknown as OtlpSpan;

describe('createWebExporter', () => {
  it('exports shortly after requests finish, gathering the ones that finish together', async () => {
    const bodies: string[] = [];
    const config = loadConfig({ IVY_ENDPOINT: 'http://ingest.invalid' });
    const queue = new ExportQueue({ url: '', maxQueueSpans: 100, exportTimeoutMs: 100, send: async (body) => (bodies.push(body), true) });
    const { sink } = createWebExporter(config, () => {}, queue);

    sink({ requestId: 'a', final: false, resource: [], spans: [span('a', true)] });
    sink({ requestId: 'a', final: true, resource: [], spans: [span('a.child')] });
    sink({ requestId: 'b', final: true, resource: [], spans: [span('b', true)] });
    expect(bodies).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 150));
    const names = bodies.map((b) => JSON.parse(b).resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans.map((s: any) => s.name))));
    // One flush, in queue order; invocation spans never share a request with children.
    expect(names).toEqual([['a'], ['a.child'], ['b']]);
    expect(queue.pending).toBe(0);
  });
});
