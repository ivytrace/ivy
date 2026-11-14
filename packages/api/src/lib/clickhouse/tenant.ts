import type { Context } from 'hono';

export function tenantOf(_c: Context): string {
  return 'default';
}
