import { describe, expect, it } from 'vitest';
import { invocationIds, newTraceId } from './ids.js';

describe('invocationIds', () => {
  it('derives the IDs the extension derives (extension/src/spans.rs, derived_ids_match_the_tracer)', () => {
    expect(invocationIds('8f1c2a7e-3b9d-4c55-9a51-0f6f1e2b7c3d', 1_700_000_000_123)).toEqual({
      traceId: '6553f100306e643c836b93bd7315f15e',
      spanId: 'aa43ecc22bca145b',
    });
  });

  it('differs per request and keeps the time prefix layout', () => {
    const a = invocationIds('req-a', Date.UTC(2026, 10, 14));
    expect(a.spanId).not.toBe(invocationIds('req-b', Date.UTC(2026, 10, 14)).spanId);
    expect(a.traceId.slice(0, 8)).toBe(newTraceId(Date.UTC(2026, 10, 14)).slice(0, 8));
  });
});
