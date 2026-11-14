import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_KEYS } from '../config/config.js';
import { capString, createKeyMatcher, redactHeaders, redactText, redactUrl, serialize, serializeBody } from './redact.js';

const isSecret = createKeyMatcher(DEFAULT_REDACT_KEYS.split(','));

describe('createKeyMatcher', () => {
  it('matches case-insensitively, ignoring - and _', () => {
    expect(isSecret('Password')).toBe(true);
    expect(isSecret('x-api-key')).toBe(true);
    expect(isSecret('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isSecret('X-Amz-Security-Token')).toBe(true);
    expect(isSecret('Set-Cookie')).toBe(true);
    expect(isSecret('username')).toBe(false);
  });
});

describe('serialize', () => {
  it('redacts keys at any depth', () => {
    const { text } = serialize({ a: { b: [{ password: 'x', ok: 1 }] }, Authorization: 'Bearer y' }, 16384, isSecret);
    expect(JSON.parse(text)).toEqual({ a: { b: [{ password: '[redacted]', ok: 1 }] }, Authorization: '[redacted]' });
  });

  it('handles cycles, bigint, buffers, errors and streams', () => {
    const o: any = { n: 10n, buf: Buffer.from('{"x":1}'), bin: Buffer.from([0xff, 0xfe]), err: new Error('boom') };
    o.self = o;
    o.stream = { pipe() {}, on() {} };
    const parsed = JSON.parse(serialize(o, 16384, isSecret).text);
    expect(parsed).toMatchObject({ n: '10', buf: { x: 1 }, bin: '[binary 2 bytes]', err: { name: 'Error', message: 'boom' }, self: '[circular]', stream: '[stream]' });
  });

  it('caps by bytes and reports truncation', () => {
    const r = serialize({ s: 'x'.repeat(100) }, 50, isSecret);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/…\[truncated 58 bytes\]$/);
    expect(Buffer.byteLength(r.text.split('…')[0])).toBe(50);
  });

  it('does not split multi-byte characters', () => {
    const r = capString('€'.repeat(10), 8);
    expect(r.text.startsWith('€€…')).toBe(true);
    expect(r.text).toContain('[truncated 24 bytes]');
  });

  it('returns empty text for undefined', () => {
    expect(serialize(undefined, 10, isSecret)).toEqual({ text: '', truncated: false });
  });
});

describe('serializeBody', () => {
  it('parses JSON bodies to redact', () => {
    expect(serializeBody('{"token":"t","a":1}', 'application/json', 1000, isSecret).text).toBe('{"token":"[redacted]","a":1}');
  });
  it('falls back to regex redaction for broken JSON and forms', () => {
    expect(redactText('{"password": "abc", "user": "u", "tok', isSecret)).toBe('{"password": "[redacted]", "user": "u", "tok');
    expect(serializeBody('user=a&password=b', 'application/x-www-form-urlencoded', 1000, isSecret).text).toBe('user=a&password=%5Bredacted%5D');
  });
});

describe('redactUrl / redactHeaders', () => {
  it('redacts query params', () => {
    expect(redactUrl('https://x.io/a?api_key=1&page=2#f', isSecret)).toBe('https://x.io/a?api_key=%5Bredacted%5D&page=2');
    expect(redactUrl('https://x.io/a', isSecret)).toBe('https://x.io/a');
  });
  it('redacts headers', () => {
    expect(JSON.parse(redactHeaders({ Authorization: 'x', 'Content-Type': 'json', accept: ['a', 'b'] }, isSecret))).toEqual({
      authorization: '[redacted]',
      'content-type': 'json',
      accept: 'a, b',
    });
  });
});
