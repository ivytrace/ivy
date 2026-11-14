import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { countSpans, decode, formatOf, PayloadTooLargeError, statusBody } from './otlp.js';
import { jsonRequest, protobufRequest } from './otlp-fixtures.js';

describe('otlp', () => {
  it('detects the format from the content type', () => {
    expect(formatOf('application/x-protobuf')).toBe('protobuf');
    expect(formatOf('application/json; charset=utf-8')).toBe('json');
    expect(formatOf('text/plain')).toBeNull();
    expect(formatOf(undefined)).toBeNull();
  });

  it('counts spans in protobuf requests', () => {
    expect(countSpans(protobufRequest([[2, 1], [3]]), 'protobuf')).toBe(6);
    expect(countSpans(Buffer.alloc(0), 'protobuf')).toBe(0);
    expect(() => countSpans(Buffer.from([0x0a, 0x50, 0x01]), 'protobuf')).toThrow(/Truncated/);
  });

  it('counts spans in JSON requests', () => {
    expect(countSpans(Buffer.from(JSON.stringify(jsonRequest(4))), 'json')).toBe(4);
    expect(() => countSpans(Buffer.from('{'), 'json')).toThrow();
  });

  it('decodes gzip within a size limit', async () => {
    const raw = Buffer.alloc(10_000, 'a');
    expect((await decode(gzipSync(raw), 'gzip', 20_000)).length).toBe(10_000);
    await expect(decode(gzipSync(raw), 'gzip', 1_000)).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(decode(raw, 'br', 20_000)).rejects.toThrow(/Unsupported/);
    expect(await decode(raw, undefined, 1)).toBe(raw);
  });

  it('encodes Status error bodies like the request', () => {
    expect(JSON.parse(statusBody('json', 16, 'nope').body.toString())).toEqual({ code: 16, message: 'nope' });
    expect([...statusBody('protobuf', 16, 'no').body]).toEqual([0x08, 16, 0x12, 2, 0x6e, 0x6f]);
  });
});
