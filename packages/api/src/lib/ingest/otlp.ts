import { promisify } from 'node:util';
import { gunzip, inflate } from 'node:zlib';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

export type OtlpFormat = 'protobuf' | 'json';

export function formatOf(contentType: string | undefined): OtlpFormat | null {
  const type = contentType?.split(';')[0].trim().toLowerCase();
  if (type === 'application/x-protobuf' || type === 'application/protobuf') return 'protobuf';
  if (type === 'application/json') return 'json';
  return null;
}

export class PayloadTooLargeError extends Error {}

/** Decompresses the body for counting (the original bytes are forwarded as they are). */
export async function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
  const enc = encoding?.trim().toLowerCase() || 'identity';
  try {
    if (enc === 'gzip') return await gunzipAsync(body, { maxOutputLength: maxBytes });
    if (enc === 'deflate') return await inflateAsync(body, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new PayloadTooLargeError('Decompressed body too large');
    throw err;
  }
  if (enc !== 'identity') throw new Error(`Unsupported content-encoding: ${enc}`);
  return body;
}

interface Field {
  num: number;
  wire: number;
  start: number;
  end: number;
}

function varint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('Truncated varint');
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [result, pos];
    shift += 7;
    if (shift > 63) throw new Error('Varint too long');
  }
}

function* fields(buf: Buffer, start: number, end: number): Generator<Field> {
  let pos = start;
  while (pos < end) {
    const [tag, afterTag] = varint(buf, pos);
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    pos = afterTag;
    let fieldStart = pos;
    if (wire === 0) pos = varint(buf, pos)[1];
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      const [len, afterLen] = varint(buf, pos);
      fieldStart = afterLen;
      pos = afterLen + len;
    } else throw new Error(`Unsupported wire type ${wire}`);
    if (pos > end) throw new Error('Truncated field');
    yield { num, wire, start: fieldStart, end: pos };
  }
}

const children = (buf: Buffer, parent: Pick<Field, 'start' | 'end'>, num: number) =>
  [...fields(buf, parent.start, parent.end)].filter((f) => f.num === num && f.wire === 2);

/**
 * Number of spans in an ExportTraceServiceRequest:
 * resource_spans (1) → scope_spans (2) → spans (2).
 */
export function countSpans(body: Buffer, format: OtlpFormat): number {
  if (format === 'json') {
    const req = JSON.parse(body.toString('utf8')) as Record<string, any>;
    let n = 0;
    for (const rs of req.resourceSpans ?? req.resource_spans ?? []) {
      for (const ss of rs.scopeSpans ?? rs.scope_spans ?? []) n += (ss.spans ?? []).length;
    }
    return n;
  }
  let n = 0;
  for (const rs of children(body, { start: 0, end: body.length }, 1)) {
    for (const ss of children(body, rs, 2)) n += children(body, ss, 2).length;
  }
  return n;
}

/** gRPC status codes used in OTLP error responses. */
export const GrpcCode = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  RESOURCE_EXHAUSTED: 8,
  UNIMPLEMENTED: 12,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** OTLP/HTTP error body: a google.rpc.Status, encoded like the request. */
export function statusBody(format: OtlpFormat | null, code: number, message: string): { body: Buffer; contentType: string } {
  if (format === 'protobuf') {
    const msg = Buffer.from(message, 'utf8');
    const parts = [Buffer.from([0x08]), encodeVarint(code), Buffer.from([0x12]), encodeVarint(msg.length), msg];
    return { body: Buffer.concat(parts), contentType: 'application/x-protobuf' };
  }
  return { body: Buffer.from(JSON.stringify({ code, message })), contentType: 'application/json' };
}

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}
