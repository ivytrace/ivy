import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import { checkoutFailed, checkoutOk, errorGroups, failureInvocations, initFailed, invocations, oomCrashed } from '@ivy/format/fixtures';
import type { Span, Trace } from '@ivy/spans';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { setClientsForTests } from '../clickhouse/client.js';
import { PROJECT_SETTING, TENANT_SETTING } from '../clickhouse/scoped.js';
import { AuthError, verifyAccessToken } from '../auth/verify.js';
import { mountAgentSurface } from './mount.js';
import { createProject } from '../tenancy/projects.js';
import { createTenant } from '../tenancy/tenants.js';
import { derivedProjectId } from '../tenancy/ids.js';
import { fixedWorkspaceAccess } from '../tenancy/members.js';
import { resetTenancyForTests, testProject } from '../tenancy/testing.js';
import type { TenantRecord } from '../tenancy/store.js';

vi.mock('../auth/verify.js', async (original) => ({
  ...(await original<typeof import('../auth/verify.js')>()),
  verifyAccessToken: vi.fn(async (token: string, { audience }: { audience?: string } = {}) => {
    if (token === 'provider-down') throw new AuthError('Identity provider unreachable', 503);
    if (token === 'mcp-token' && audience === 'https://ivy.example.com/mcp') {
      return { sub: 'idn_1', issuer: 'https://auth.example.com', clientId: 'agt_ivy_1', agent: null };
    }
    throw new AuthError('Invalid token', 401);
  }),
}));

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

/** The OOM trace as stored: report data arrives later as an update span with the root's span ID. */
const REPORT_KEYS = ['ivy.billed_duration_ms', 'ivy.memory_max_used_mb', 'ivy.memory_size_mb'];
const oomRoot = oomCrashed.spans[0];
const oomStored: Trace = {
  trace_id: oomCrashed.trace_id,
  spans: [
    { ...oomRoot, attributes: Object.fromEntries(Object.entries(oomRoot.attributes).filter(([k]) => !REPORT_KEYS.includes(k))) },
    ...oomCrashed.spans.slice(1),
    {
      ...oomRoot,
      status_code: 'UNSET',
      status_message: '',
      events: [],
      attributes: { 'ivy.update': 'true', ...Object.fromEntries(REPORT_KEYS.map((k) => [k, oomRoot.attributes[k]])) },
    },
  ],
};
const storedTraces = [checkoutFailed, checkoutOk, initFailed, oomStored];

/** invocations rows as the invocations route selects them (absent values as '' / 0). */
const invocationRow = (tenant: unknown) => (i: (typeof invocations)[number]) => ({
  ...i, project_id: derivedProjectId(String(tenant)), ts_ms: ms(i.ts), http_method: i.http_method ?? '', http_path: i.http_path ?? '', http_status: i.http_status ?? 0,
  error_type: i.error_type ?? '', error_message: i.error_message ?? '', memory_used_mb: i.memory_used_mb ?? 0,
  memory_limit_mb: i.memory_limit_mb ?? 0, failure_phase: i.failure_phase ?? '', init_duration_ms: i.init_duration_ms ?? 0,
});

let captured: Captured[] = [];
const fake = {
  query: async (params: Captured) => {
    captured.push(params);
    const sql = params.query;
    let rows: unknown[] = [];
    if (sql.includes('FROM otel_traces')) {
      const trace = storedTraces.find((t) => t.trace_id === params.query_params.trace_id);
      rows = trace ? spanRows(trace) : [];
    } else if (sql.includes('AS error_template')) {
      rows = errorGroups.map((g) => ({
        ...g,
        latest_message: g.error_message,
        first_seen_ms: ms(g.first_seen),
        last_seen_ms: ms(g.last_seen),
        failure_phase: g.failure_kind === 'init_failed' ? 'init' : '',
        top: g.top_messages.map((m) => [m.message, m.count, m.sample_trace_id, ms(m.last_seen)]),
      }));
    } else if (sql.includes('FROM invocations')) {
      rows = [...invocations, ...failureInvocations]
        .filter((i) => !params.query_params.status || i.status === params.query_params.status)
        .filter((i) => !params.query_params.function || i.function === params.query_params.function)
        .map(invocationRow(params.query_params.tenant));
    }
    return { json: async () => rows };
  },
} as unknown as ClickHouseClient;

let workspace: TenantRecord;
const appWith = (uiDir = '/nonexistent') => createApp({ uiDir, access: fixedWorkspaceAccess(workspace) });

beforeEach(async () => {
  await resetTenancyForTests();
  workspace = await createTenant('Acme', undefined, 'ten_a', 'acme');
  await testProject(workspace.id);
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
    const client = await connect(appWith());
    expect((await client.listTools()).tools).toHaveLength(9);

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

    const data = captured.filter((q) => /FROM (otel_traces|invocations)/.test(q.query));
    expect(data.length).toBeGreaterThan(5);
    for (const q of data) {
      expect(q.query_params.tenant).toBe('ten_a');
      expect(q.clickhouse_settings[TENANT_SETTING]).toBe('ten_a');
    }
  });

  it('labels failures outside the handler and says when there is no trace', async () => {
    const client = await connect(appWith());
    const failing = textOf(await client.callTool({ name: 'find_failing_invocations', arguments: { function: 'reports-export' } }));
    expect(failing).toContain("Init failed · Runtime.ImportModuleError: Error: Cannot find module 'left-pad' · no request");
    expect(failing).toContain('no trace: the runtime never started the handler');
    expect(failing).toContain('Out of memory · Runtime.OutOfMemory');

    const groups = textOf(await client.callTool({ name: 'list_error_groups', arguments: {} }));
    expect(groups).toContain('3× reports-export · Init failed · Runtime.ImportModuleError');

    const summary = textOf(await client.callTool({ name: 'get_trace_summary', arguments: { trace_id: oomCrashed.trace_id } }));
    expect(summary).toContain('ERROR (Out of memory)');
    expect(summary).toContain('128 MB used of 128 MB · billed 2381ms');
  });

  it('turns API validation errors into tool errors', async () => {
    const client = await connect(appWith());
    const result = (await client.callTool({ name: 'search_invocations', arguments: { since: '0m' } })) as CallToolResult;
    expect(textOf(result)).toContain('(Invalid since: 0m)');
    expect(result.isError).toBe(true);
  });

  it('narrows reads to a project with `project`, and reads all projects without it', async () => {
    const staging = await createProject('ten_a', { name: 'Checkout (staging)' });
    const client = await connect(appWith());
    const run = async (args: Record<string, unknown>) => {
      captured = [];
      await client.callTool({ name: 'find_failing_invocations', arguments: args });
      return captured.filter((q) => /FROM invocations/.test(q.query));
    };
    for (const q of await run({ project: 'checkout-staging' })) {
      expect(q.query_params).toMatchObject({ tenant: 'ten_a', project: staging.id });
      expect(q.clickhouse_settings[PROJECT_SETTING]).toBe(staging.id);
    }
    expect(await run({ project: 'nope' })).toEqual([]);
    const all = await run({});
    expect(all.length).toBeGreaterThan(0);
    for (const q of all) expect(q.query_params.project).toBeUndefined();

    // All-projects rows say which project they're from, as the API's workspace-wide routes do.
    const text = textOf(await client.callTool({ name: 'find_failing_invocations', arguments: { function: 'checkout-createOrder' } }));
    expect(text).toMatch(/^\[acme\/default\] /m);
    const scoped = textOf(await client.callTool({ name: 'find_failing_invocations', arguments: { function: 'checkout-createOrder', project: 'default' } }));
    expect(scoped).toMatch(/^\[acme\] /m);
  });

  it('fans out over all workspaces, one tenant-scoped query per workspace, labelled', async () => {
    const ws = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), tenant: { id, shardId: 'shard-1' } });
    const app = new Hono();
    mountAgentSurface(app, undefined, { workspaces: async () => [ws('ten_a', 'Prod'), ws('ten_b', 'Staging')] });
    const client = await connect(app);

    const text = textOf(await client.callTool({ name: 'find_failing_invocations', arguments: { since: '24h' } }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('8 failed invocations in 2 workspaces, last 24h, newest first:');
    expect(lines.filter((l) => l.startsWith('[prod/default] '))).toHaveLength(4);
    // (ten_b isn't in the control plane here, so its project slug is unknown and left out.)
    expect(lines.filter((l) => l.startsWith('[staging] '))).toHaveLength(4);

    const data = captured.filter((q) => /FROM (otel_traces|invocations)/.test(q.query));
    expect(data.map((q) => q.query_params.tenant).sort()).toEqual(['ten_a', 'ten_b']);
    for (const q of data) expect(q.clickhouse_settings[TENANT_SETTING]).toBe(q.query_params.tenant);

    expect(textOf(await client.callTool({ name: 'list_workspaces', arguments: {} }))).toBe(
      '2 workspaces:\nprod · Prod · ten_a\nstaging · Staging · ten_b',
    );
  });

  it('is an OAuth protected resource checked with the OIDC verifier and the MCP audience', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.example.com');
    vi.stubEnv('IVY_OIDC_CLIENT_ID', 'ivy-dashboard');
    vi.stubEnv('IVY_MCP_RESOURCE', 'https://ivy.example.com/mcp');
    const app = new Hono();
    mountAgentSurface(app, fixedWorkspaceAccess(workspace));

    const metadata = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(metadata).toMatchObject({ resource: 'https://ivy.example.com/mcp', authorization_servers: ['https://auth.example.com'] });

    const missing = await app.request('/mcp', { method: 'POST' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://ivy.example.com/.well-known/oauth-protected-resource/mcp"');

    const apiToken = await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer api-token' } });
    expect(apiToken.status).toBe(401);
    expect(apiToken.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const client = await connect(app, { authorization: 'Bearer mcp-token' });
    expect((await client.listTools()).tools).toHaveLength(9);
    expect(verifyAccessToken).toHaveBeenCalledWith('mcp-token', { audience: 'https://ivy.example.com/mcp', mcpClients: true });
  });

  it('answers 503 when the identity provider is unreachable', async () => {
    vi.stubEnv('IVY_OIDC_ISSUER', 'https://auth.example.com');
    vi.stubEnv('IVY_OIDC_CLIENT_ID', 'ivy-dashboard');
    vi.stubEnv('IVY_PUBLIC_URL', 'https://ivy.example.com');
    const app = appWith();
    const res = await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer provider-down' } });
    expect(res.status).toBe(503);
  });
});

describe('MCP Apps views', () => {
  it('serves the views built into <uiDir>/mcp-apps and links the render tools to them', async () => {
    const uiDir = mkdtempSync(path.join(tmpdir(), 'ivy-ui-'));
    mkdirSync(path.join(uiDir, 'mcp-apps'));
    writeFileSync(path.join(uiDir, 'mcp-apps', 'waterfall.html'), '<!doctype html><title>w</title>');
    const client = await connect(appWith(uiDir));

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'render_waterfall')?._meta).toMatchObject({ ui: { resourceUri: 'ui://ivy/waterfall.html' } });
    expect(tools.find((t) => t.name === 'render_graph')?._meta?.ui).toBeUndefined();
    const read = await client.readResource({ uri: 'ui://ivy/waterfall.html' });
    expect(read.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><title>w</title>' });

    const result = (await client.callTool({ name: 'render_waterfall', arguments: { trace_id: checkoutFailed.trace_id } })) as CallToolResult;
    expect(result.structuredContent).toMatchObject({ workspace: { id: 'ten_a' }, trace: { trace_id: checkoutFailed.trace_id } });
  });
});

describe('GET …/traces/:id?format=text', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = appWith();
  });

  it('returns the text tree', async () => {
    const res = await app.request(`/api/w/acme/p/default/traces/${checkoutFailed.trace_id}?format=text&detail=summary`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('checkout-createOrder · API Gateway POST /orders → 500 · cold start · 212ms · ERROR');
    expect(text).not.toContain('req:');
  });

  it('validates detail and max_tokens', async () => {
    expect((await app.request(`/api/w/acme/p/default/traces/${checkoutFailed.trace_id}?format=text&detail=huge`)).status).toBe(400);
    expect((await app.request(`/api/w/acme/p/default/traces/${checkoutFailed.trace_id}?format=text&max_tokens=-1`)).status).toBe(400);
  });

  it('merges update spans into the invocation span and leaves them out of the span list', async () => {
    const res = await app.request(`/api/w/acme/p/default/traces/${oomCrashed.trace_id}`);
    const { spans } = (await res.json()) as Trace;
    expect(spans).toHaveLength(oomCrashed.spans.length);
    expect(spans.filter((s) => s.span_id === oomRoot.span_id)).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({ 'ivy.billed_duration_ms': '2381', 'ivy.memory_max_used_mb': '128', 'error.type': 'Runtime.OutOfMemory' });
    expect(spans[0].attributes['ivy.update']).toBeUndefined();
    expect(spans[0].status_code).toBe('ERROR');
  });

  it('still returns JSON by default', async () => {
    const res = await app.request(`/api/w/acme/p/default/traces/${checkoutFailed.trace_id}`);
    expect((await res.json()).spans).toHaveLength(checkoutFailed.spans.length);
  });
});
