import { describe, expect, it } from 'vitest';
import { tracerName } from './tracers.js';

describe('tracerName', () => {
  it('names well-known tracers from their exec wrapper', () => {
    expect(tracerName('/opt/lumigo_wrapper')).toBe('Lumigo');
    expect(tracerName('/opt/datadog_wrapper')).toBe('Datadog');
    expect(tracerName('/opt/otel-handler')).toBe('OpenTelemetry');
  });

  it('returns null for wrappers it does not know', () => {
    expect(tracerName('/opt/custom-wrapper')).toBeNull();
    expect(tracerName('')).toBeNull();
  });
});
