const POOL_SIZE = 4096;
const pool = Buffer.allocUnsafe(POOL_SIZE);
let offset = POOL_SIZE;

function randomHex(bytes: number): string {
  if (offset + bytes > POOL_SIZE) {
    process.getBuiltinModule('node:crypto').randomFillSync(pool);
    offset = 0;
  }
  const hex = pool.toString('hex', offset, offset + bytes);
  offset += bytes;
  return hex;
}

/** 128-bit trace ID: 8 hex chars of big-endian unix seconds + 24 random hex chars. */
export function newTraceId(nowMs: number = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000) >>> 0;
  return seconds.toString(16).padStart(8, '0') + randomHex(12);
}

function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * IDs of the invocation span, derived from the request ID so the extension knows them before the tracer reports
 * (it exports an in-progress span for long invocations): FNV-1a 32 of `"<i>:<request id>"` for i = 0..4. The span
 * ID is the first 16 hex chars; the trace ID is the start second plus the other 24. Same as the extension's
 * `derived_ids`.
 */
export function invocationIds(requestId: string, startMs: number): { traceId: string; spanId: string } {
  let hex = '';
  for (let i = 0; i < 5; i++) hex += fnv1a32(`${i}:${requestId}`);
  const seconds = Math.floor(startMs / 1000) >>> 0;
  const spanId = hex.slice(0, 16) === '0000000000000000' ? '0000000000000001' : hex.slice(0, 16);
  return { traceId: seconds.toString(16).padStart(8, '0') + hex.slice(16), spanId };
}

export function newSpanId(): string {
  let id = randomHex(8);
  while (id === '0000000000000000') id = randomHex(8);
  return id;
}
