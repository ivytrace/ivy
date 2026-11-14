import type { Context } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { publicAuthConfig, readAuthConfig } from '../../lib/auth/config.js';
import { emailEnabled } from '../../lib/email/send.js';
import { multiWorkspaceMode } from '../../lib/tenancy/members.js';

export function getConfig(c: Context) {
  return c.json({
    version: pkg.version,
    auth: publicAuthConfig(readAuthConfig()),
    workspaces: { multi: multiWorkspaceMode() },
    email: { enabled: emailEnabled() },
  });
}
