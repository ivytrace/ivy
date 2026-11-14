export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

export function zeroToNull(value: number): number | null {
  return value === 0 ? null : value;
}

export function round(value: number, decimals = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
