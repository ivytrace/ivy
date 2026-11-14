export function normalizeKind(kind: string): string {
  const value = kind.replace(/^SPAN_KIND_/i, '').toUpperCase();
  return value === 'UNSPECIFIED' || value === '' ? 'INTERNAL' : value;
}

export function normalizeStatus(code: string): 'OK' | 'ERROR' | 'UNSET' {
  const value = code.replace(/^STATUS_CODE_/i, '').toUpperCase();
  return value === 'OK' || value === 'ERROR' ? value : 'UNSET';
}
