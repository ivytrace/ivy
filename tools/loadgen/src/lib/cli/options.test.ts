import { describe, expect, it } from 'vitest';
import { parseOptions } from './options.js';

describe('parseOptions', () => {
  it('has sensible defaults', () => {
    expect(parseOptions([], {})).toEqual({
      count: 500,
      rate: 20,
      backfillHours: 0,
      endpoint: 'http://localhost:4318',
      key: 'dev-ingest-key',
      batch: 100,
    });
  });

  it('parses flags and ignores a pnpm "--" separator', () => {
    const opts = parseOptions(['--', '--count', '5000', '--backfill', '24', '--key', 'k', '--endpoint', 'http://c:4318'], {});
    expect(opts).toMatchObject({ count: 5000, backfillHours: 24, rate: 0, key: 'k', endpoint: 'http://c:4318' });
  });

  it('rejects bad values', () => {
    expect(() => parseOptions(['--count', 'lots'], {})).toThrow();
    expect(() => parseOptions(['--count', '0', '--backfill', '2'], {})).toThrow();
  });
});
