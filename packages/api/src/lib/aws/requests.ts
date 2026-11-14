import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { badRequest } from '../utils/http-error.js';
import { tenantOf } from '../tenancy/context.js';
import { isRegion } from './regions.js';
import { awsStore } from './store.js';
import type { AwsAccount } from './types.js';

export async function loadAccount(c: Context): Promise<AwsAccount> {
  const account = await awsStore().getAccount(tenantOf(c).id, c.req.param('id') ?? '');
  if (!account) throw new HTTPException(404, { message: 'Account not found' });
  return account;
}

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  return body as Record<string, unknown>;
}

export function parseRegions(value: unknown, field = 'regions'): string[] {
  if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && isRegion(r))) {
    throw badRequest(`${field} must be an array of AWS region names`);
  }
  return [...new Set(value as string[])];
}
