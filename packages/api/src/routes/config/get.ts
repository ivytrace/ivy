import type { Context } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { publicAuthConfig, readAuthConfig } from '../../lib/auth/config.js';
import { quickCreateAvailable } from '../../lib/aws/publish.js';
import { emailEnabled } from '../../lib/email/send.js';
import { multiWorkspaceMode } from '../../lib/tenancy/members.js';

/** Where the UI sends Upgrade / Manage billing (hosted only; no billing buttons without it). */
const billingUrl = () => process.env.IVY_BILLING_URL?.trim().replace(/\/$/, '') || undefined;

export async function getConfig(c: Context) {
  return c.json({
    version: pkg.version,
    auth: publicAuthConfig(readAuthConfig()),
    workspaces: { multi: multiWorkspaceMode() },
    email: { enabled: emailEnabled() },
    aws: { quick_create: await quickCreateAvailable() },
    ...(billingUrl() ? { billing: { url: billingUrl() } } : {}),
  });
}
