import type { ClickHouseClient } from '@clickhouse/client';
import { checkoutFailed, checkoutOk, errorGroups, invocations } from '@ivy/format/fixtures';
import type { Span, Trace } from '@ivy/spans';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { setClientsForTests } from '../clickhouse/client.js';
import { TENANT_SETTING } from '../clickhouse/scoped.js';
import { singleTenantResolver } from '../tenancy/context.js';
import { mountAgentSurface } from './mount.js';

interface Captured {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings: Record<string, unknown>;
}

const ms = (iso: string) => Date.parse(iso);

/** otel_traces rows as the traces route selects them. */
const spanRows = (trace: Trace) =>
  trace.spans.map((s: Span) => ({
    span_id: s.span_id, parent_span_id: s.parent_span_id, name: s.name, kind: `SPAN_KIND_${s.kind}`, service: s.service,
    start_ms: ms(s.start), duration_ns: s.duration_ms * 1e6, status_code: `STATUS_CODE_${s.status_code}`,
    status_message: s.status_message, attributes: s.attributes, resource: s.resource,
    event_ts_ms: s.events.map((e) => ms(e.ts)), event_names: s.events.map((e) => e.name), event_attributes: s.events.map((e) => e.attributes),
  }));

let captured: Captured[] = [];
const fake = {
  query: async (params: Captured) => {
    captured.push(params);
    const sql = params.query;
    let rows: unknown[] = [];
    if (sql.includes('FROM otel_traces')) {
      const trace = [checkoutFailed, checkoutOk].find((t) => t.trace_id === params.query_params.trace_id);
      rows = trace ? spanRows(trace) : [];
    } else if (sql.includes('error_fingerprint')) {
      rows = errorGroups.map((g) => ({ ...g, first_seen_ms: ms(g.first_seen), last_seen_ms: ms(g.last_seen) }));
    } else if (sql.includes('FROM invocations')) {
      rows = invocations
        .filter((i) => !params.query_params.status || i.status === params.query_params.status)
        .map((i) => ({ ...i, ts_ms: ms(i.ts), http_method: i.http_method ?? '', http_path: i.http_path ?? '', http_status: i.http_status ?? 0, error_type: i.error_type ?? '', error_message: i.error_message ?? '' }));
    }
    return { json: async () => rows };
  },
} as unknown as ClickHouseClient;

const tenants = { resolve: async () => ({ id: 'ten_a', shardId: 'shard-1' }) };

beforeEach(() => {
  captured = [];
  setClientsForTests({ shard: fake, control: fake });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => setClientsForTests(undefined));

async function connect(app: Hono, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL('http://ivy.test/mcp'), {
    fetch: async (url, init) => app.request(url.toString(), init),
    requestInit: { headers },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) => ((result as CallToolResult).content[0] as { text: string }).text;

describe('MCP endpoint in the API', () => {
  it('serves every tool through the API route handlers, scoped to the request tenant', async () => {
    const client = await connect(createApp({ uiDir: '/nonexistent', tenants }));
    expect((await client.listTools()).tools).toHaveLength(5);

    const calls = {
      find_failing_invocations: { function: 'checkout-createOrder' },
      search_invocations: { q: 'orders', status: 'ok' },
      list_error_groups: {},
      get_trace_summary: { trace_id: checkoutFailed.trace_id },
      compare_invocations: { trace_id: checkoutFailed.trace_id },
    };
    const outputs: Record<string, string> = {};
    for (const [name, args] of Object.entries(calls)) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy();
      outputs[name] = textOf(result);
    }

    expect(outputs.get_trace_summary).toContain('checkout-createOrder · API Gateway POST /orders → 500 · cold start · 212ms · ERROR');
    expect(outputs.compare_invocations).toContain(`trace ${checkoutOk.trace_id}`);
    expect(outputs.list_error_groups).toContain('42× checkout-createOrder');

    expect(captured.length).toBeGreaterThan(5);
    for (const q of captured) {
      expect(q.query_params.tenant).toBe('ten_a');
      expect(q.clickhouse_settings[TENANT_SETTING]).toBe('ten_a');
    }
  });

  it('turns API validation errors into tool errors', async () => {
    const client = await connect(createApp({ uiDir: '/nonexistent', tenants }));
    const result = (await client.callTool({ name: 'search_invocations', arguments: { since: '0m' } })) as CallToolResult;
    expect(textOf(result)).toBe('Ivy query failed: Invalid since: 0m');
    expect(result.isError).toBe(true);
  });

  it('answers 401 when the tenant resolver rejects the request', async () => {
    const app = createApp({ uiDir: '/nonexistent', tenants: { resolve: async () => null } });
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('is an OAuth protected resource when OIDC is configured', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.ivytrace.dev');
    vi.stubEnv('IVY_MCP_RESOURCE', 'https://ivytrace.dev/mcp');
    const app = new Hono();
    const verifier = { verify: async (token: string, { audience }: { audience: string }) => (token === 'mcp-token' && audience === 'https://ivytrace.dev/mcp' ? { sub: 'u1' } : null) };
    mountAgentSurface(app, tenants, verifier);

    const metadata = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(metadata).toMatchObject({ resource: 'https://ivytrace.dev/mcp', authorization_servers: ['https://auth.ivytrace.dev'] });

    const res = await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer api-token' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://ivytrace.dev/.well-known/oauth-protected-resource/mcp"');

    const client = await connect(app, { authorization: 'Bearer mcp-token' });
    expect((await client.listTools()).tools).toHaveLength(5);
  });

  it('fails closed with OIDC configured until the verifier is wired', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.ivytrace.dev');
    vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.com');
    const app = new Hono();
    mountAgentSurface(app, singleTenantResolver());
    const res = await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer anything' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('https://ivy.example.com/.well-known/oauth-protected-resource/mcp');
  });
});

describe('GET /api/traces/:id?format=text', () => {
  const app = createApp({ uiDir: '/nonexistent', tenants });

  it('returns the text tree', async () => {
    const res = await app.request(`/api/traces/${checkoutFailed.trace_id}?format=text&detail=summary`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('checkout-createOrder · API Gateway POST /orders → 500 · cold start · 212ms · ERROR');
    expect(text).not.toContain('req:');
  });

  it('validates detail and max_tokens', async () => {
    expect((await app.request(`/api/traces/${checkoutFailed.trace_id}?format=text&detail=huge`)).status).toBe(400);
    expect((await app.request(`/api/traces/${checkoutFailed.trace_id}?format=text&max_tokens=-1`)).status).toBe(400);
  });

  it('still returns JSON by default', async () => {
    const res = await app.request(`/api/traces/${checkoutFailed.trace_id}`);
    expect((await res.json()).spans).toHaveLength(checkoutFailed.spans.length);
  });
});
