import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import { openApiDocument } from '../../lib/openapi/spec.js';

export function getOpenApi(c: Context) {
  return c.json(openApiDocument);
}

/** API reference page; Scalar's script loads from its CDN. */
export const getApiDocs = Scalar({ url: '/api/openapi.json', pageTitle: 'Ivy API', theme: 'saturn', darkMode: true, forceDarkModeState: 'dark', hideDarkModeToggle: true });
