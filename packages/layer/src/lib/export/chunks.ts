import { byteLength, isPayloadKey } from '../tracer/payload-budget.js';
import type { OtlpSpan } from './otlp.js';

export interface ChunkLimits {
  spans: number;
  bytes: number;
}

/**
 * Removes payload attributes, largest first, until the span serializes to at most `maxBytes`, and
 * marks it `ivy.payload.trimmed`. Returns the bytes removed. A span still too large afterwards (huge
 * log events) is sent on its own.
 */
export function trimSpanPayloads(span: OtlpSpan, maxBytes: number, size = byteLength(JSON.stringify(span))): number {
  if (size <= maxBytes) return 0;
  const payloads = span.attributes
    .filter((a) => isPayloadKey(a.key) && 'stringValue' in a.value)
    .map((a) => ({ key: a.key, bytes: byteLength((a.value as { stringValue: string }).stringValue) }))
    .sort((a, b) => b.bytes - a.bytes);
  let removed = 0;
  const drop = new Set<string>();
  for (const p of payloads) {
    if (size - removed <= maxBytes) break;
    drop.add(p.key);
    removed += p.bytes;
  }
  if (!drop.size) return 0;
  span.attributes = span.attributes.filter((a) => !drop.has(a.key) && a.key !== 'ivy.payload.trimmed');
  span.attributes.push({ key: 'ivy.payload.trimmed', value: { boolValue: true } });
  return removed;
}

/** Splits spans into chunks of at most `limits.spans` spans and `limits.bytes` of serialized JSON. */
export function chunkSpans(spans: OtlpSpan[], limits: ChunkLimits): OtlpSpan[][] {
  const chunks: OtlpSpan[][] = [];
  let current: OtlpSpan[] = [];
  let bytes = 0;
  for (const span of spans) {
    let size = byteLength(JSON.stringify(span));
    if (size > limits.bytes) {
      trimSpanPayloads(span, limits.bytes, size);
      size = byteLength(JSON.stringify(span));
    }
    if (current.length && (current.length >= limits.spans || bytes + size > limits.bytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(span);
    bytes += size + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
