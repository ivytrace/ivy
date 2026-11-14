import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { serveUi } from './serve-ui.js';

let app: Hono;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ivy-ui-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<html>index</html>');
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  app = new Hono();
  app.use('*', serveUi(root));
});

describe('serveUi', () => {
  it('serves files with a content type', async () => {
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for client routes', async () => {
    const res = await app.request('/functions/checkout');
    expect(await res.text()).toBe('<html>index</html>');
  });

  it('does not escape the root', async () => {
    const res = await app.request('/../../etc/passwd');
    expect(await res.text()).toBe('<html>index</html>');
  });
});
