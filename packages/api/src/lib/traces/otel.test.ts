import { describe, expect, it } from 'vitest';
import { normalizeKind, normalizeStatus } from './otel.js';

describe('otel enum normalization', () => {
  it('maps exporter span kinds to upper case names', () => {
    expect(normalizeKind('Server')).toBe('SERVER');
    expect(normalizeKind('SPAN_KIND_CLIENT')).toBe('CLIENT');
    expect(normalizeKind('Unspecified')).toBe('INTERNAL');
  });

  it('maps status codes', () => {
    expect(normalizeStatus('Error')).toBe('ERROR');
    expect(normalizeStatus('Ok')).toBe('OK');
    expect(normalizeStatus('Unset')).toBe('UNSET');
    expect(normalizeStatus('STATUS_CODE_ERROR')).toBe('ERROR');
  });
});
