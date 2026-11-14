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

export interface TrafficCount {
  spans: number;
  /** Spans marked `ivy.invocation = true` (in-progress records excluded): one per Lambda invocation, i.e. one trace (a row of `invocations`). */
  invocations: number;
}

const INVOCATION_KEY = Buffer.from('ivy.invocation', 'utf8');
const IN_PROGRESS_KEY = Buffer.from('ivy.in_progress', 'utf8');
const TRUE = Buffer.from('true', 'utf8');

/** KeyValue (key = 1, value = 2) → AnyValue (string_value = 1, bool_value = 2). */
function isTrueAttribute(buf: Buffer, kv: Field, key: Buffer): boolean {
  let keyMatches = false;
  let value: Field | undefined;
  for (const f of fields(buf, kv.start, kv.end)) {
    if (f.num === 1 && f.wire === 2) keyMatches = buf.subarray(f.start, f.end).equals(key);
    else if (f.num === 2 && f.wire === 2) value = f;
  }
  if (!keyMatches || !value) return false;
  for (const f of fields(buf, value.start, value.end)) {
    if (f.num === 1 && f.wire === 2) return buf.subarray(f.start, f.end).equals(TRUE);
    if (f.num === 2 && f.wire === 0) return varint(buf, f.start)[0] === 1;
  }
  return false;
}

const jsonIsTrue = (span: Record<string, any>, key: string): boolean =>
  (span.attributes ?? []).some((a: Record<string, any>) => a?.key === key && (a.value?.stringValue === 'true' || a.value?.boolValue === true));

/** An invocation span, except an in-progress record (the final span with the same ID is the one that counts). */
const jsonIsInvocation = (span: Record<string, any>): boolean => jsonIsTrue(span, 'ivy.invocation') && !jsonIsTrue(span, 'ivy.in_progress');

/**
 * Spans and invocations in an ExportTraceServiceRequest:
 * resource_spans (1) → scope_spans (2) → spans (2) → attributes (9).
 */
export function countTraffic(body: Buffer, format: OtlpFormat): TrafficCount {
  const out = { spans: 0, invocations: 0 };
  if (format === 'json') {
    const req = JSON.parse(body.toString('utf8')) as Record<string, any>;
    for (const rs of req.resourceSpans ?? req.resource_spans ?? []) {
      for (const ss of rs.scopeSpans ?? rs.scope_spans ?? []) {
        for (const span of ss.spans ?? []) {
          out.spans++;
          if (jsonIsInvocation(span)) out.invocations++;
        }
      }
    }
    return out;
  }
  for (const rs of children(body, { start: 0, end: body.length }, 1)) {
    for (const ss of children(body, rs, 2)) {
      for (const span of children(body, ss, 2)) {
        out.spans++;
        const attributes = children(body, span, 9);
        if (attributes.some((kv) => isTrueAttribute(body, kv, INVOCATION_KEY)) && !attributes.some((kv) => isTrueAttribute(body, kv, IN_PROGRESS_KEY))) out.invocations++;
      }
    }
  }
  return out;
}

export const countSpans = (body: Buffer, format: OtlpFormat): number => countTraffic(body, format).spans;

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
