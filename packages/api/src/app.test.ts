import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const app = createApp({ uiDir: '/nonexistent' });

describe('app', () => {
  it('returns config', async () => {
    const res = await app.request('/api/config');
    expect(await res.json()).toEqual({ version: '0.1.0', auth: { enabled: false } });
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('validates query params before touching ClickHouse', async () => {
    const res = await app.request('/api/invocations?since=forever');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid since: forever' });
  });

  it('returns 404 for malformed trace IDs', async () => {
    const res = await app.request('/api/traces/not-a-trace');
    expect(res.status).toBe(404);
  });
});
