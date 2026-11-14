import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import type { OtlpAnyValue, OtlpSpan } from '../export/otlp.js';
import { Tracer, type SpanBatch } from '../tracer/tracer.js';
import { GLOBAL_KEY } from './api.js';
import { installOtelBridge } from './index.js';

const plain = (v: OtlpAnyValue): unknown => {
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  return v.arrayValue.values.map(plain);
};

export const attrs = (span: Pick<OtlpSpan, 'attributes'>) => Object.fromEntries(span.attributes.map((a) => [a.key, plain(a.value)]));

export function resetGlobal(): void {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
}

/** A tracer with the bridge installed, and a helper that runs `fn` as one invocation and returns its spans. */
export function setupBridge(env: Record<string, string> = {}) {
  const batches: SpanBatch[] = [];
  const tracer = new Tracer(loadConfig({ IVY_ENDPOINT: 'http://x', ...env }), (b) => batches.push(b));
  installOtelBridge(tracer, { LAMBDA_TASK_ROOT: mkdtempSync(join(tmpdir(), 'ivy-app-')), ...env });
  let n = 0;
  const invoke = async (fn: () => unknown) => {
    const inv = tracer.startInvocation({}, { awsRequestId: `req-${++n}`, functionName: 'support-bot' });
    let error: unknown = null;
    try {
      await fn();
    } catch (e) {
      error = e;
    }
    tracer.endInvocation(inv, error, { ok: true });
    await new Promise((r) => setImmediate(r));
    const batch = batches.find((b) => b.requestId === `req-${n}` && b.final)!;
    const [root, ...children] = batch.spans;
    const byName = (name: string | RegExp) => children.filter((s) => (typeof name === 'string' ? s.name === name : name.test(s.name)));
    return { root, children, byName };
  };
  return { tracer, invoke };
}
