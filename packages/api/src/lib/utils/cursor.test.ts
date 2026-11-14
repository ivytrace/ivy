import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor', () => {
  it('round-trips', () => {
    const cursor = { ts: 1731600000123, spanId: 'abcdef0123456789' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow();
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrow();
  });
});
