import type { Context } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { publicAuthConfig, readAuthConfig } from '../../lib/auth/config.js';

/** Where the UI sends Upgrade / Manage billing (hosted only; no billing buttons without it). */
const billingUrl = () => process.env.IVY_BILLING_URL?.trim().replace(/\/$/, '') || undefined;

export function getConfig(c: Context) {
  const url = billingUrl();
  return c.json({ version: pkg.version, auth: publicAuthConfig(readAuthConfig()), ...(url ? { billing: { url } } : {}) });
}
