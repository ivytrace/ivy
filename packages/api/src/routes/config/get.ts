import type { Context } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { publicAuthConfig, readAuthConfig } from '../../lib/auth/config.js';

export function getConfig(c: Context) {
  return c.json({ version: pkg.version, auth: publicAuthConfig(readAuthConfig()) });
}
