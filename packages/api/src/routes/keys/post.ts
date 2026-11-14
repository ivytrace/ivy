import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { jsonBody } from '../../lib/aws/requests.js';
import { projectOf, tenantOf } from '../../lib/tenancy/context.js';
import { createApiKey } from '../../lib/tenancy/tenants.js';
import { presentKey } from './get.js';

const env = (name: string) => process.env[name]?.trim() || null;

/** Mints an ingest key for the project: `{ "name": "ci" }`. The key is in this response only. */
export async function postKey(c: Context) {
  const project = projectOf(c);
  if (project.archived) throw new HTTPException(409, { message: 'The project is archived' });
  const body = await jsonBody(c);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'Ingest key';
  const { key, record } = await createApiKey(tenantOf(c).id, project.id, name);
  return c.json({ ...presentKey(record), key, endpoint: env('IVY_INGEST_PUBLIC_URL')?.replace(/\/$/, '') ?? null }, 201);
}
