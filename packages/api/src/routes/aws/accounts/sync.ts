import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { loadAccount } from '../../../lib/aws/requests.js';
import { triggerSync } from '../../../lib/aws/scheduler.js';

/** Starts a sync in the background; `?wait=1` waits for it to finish. */
export async function syncAwsAccount(c: Context) {
  const account = await loadAccount(c);
  if (account.status === 'pending') throw new HTTPException(409, { message: 'Verify the account first' });
  const run = triggerSync(account);
  if (c.req.query('wait')) await run;
  return c.json({ started: true }, 202);
}
