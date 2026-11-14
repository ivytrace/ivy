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

export function newSpanId(): string {
  let id = randomHex(8);
  while (id === '0000000000000000') id = randomHex(8);
  return id;
}
