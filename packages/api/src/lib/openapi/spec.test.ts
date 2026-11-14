import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { openApiDocument } from './spec.js';

const app = createApp({ uiDir: '/nonexistent' });

/** `GET /api/traces/{traceId}` for every concrete /api route registered in the app (middleware and catch-alls excluded). */
function appRoutes(): string[] {
  const routes = app.routes
    .filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL' && !r.path.includes('*'))
    .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
  return [...new Set(routes)].sort();
}

function specRoutes(): string[] {
  return Object.entries(openApiDocument.paths)
    .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
}

describe('OpenAPI document', () => {
  it('describes exactly the routes the app serves', () => {
    expect(specRoutes()).toEqual(appRoutes());
  });

  it('resolves every schema reference', () => {
    const refs = [...JSON.stringify(openApiDocument).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    for (const name of refs) expect(openApiDocument.components.schemas).toHaveProperty(name);
  });

  it('is served at /api/openapi.json, with a docs page', async () => {
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    expect((await res.json()).openapi).toBe('3.1.0');
    const docs = await app.request('/api/docs');
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('/api/openapi.json');
  });
});
