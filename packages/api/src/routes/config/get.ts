import type { Context } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };

export function getConfig(c: Context) {
  return c.json({ version: pkg.version, auth: { enabled: false } });
}
