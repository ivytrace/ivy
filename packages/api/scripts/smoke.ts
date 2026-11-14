/** Hits every endpoint of a running API and checks response shapes against docs/implementation/api.md. */
const base = (process.argv.slice(2).find((a) => a !== '--') ?? process.env.IVY_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** Data routes of one project (auth off: the default workspace and the bootstrap key's "Default" project). */
const P = `/api/w/${process.env.IVY_SMOKE_WORKSPACE ?? 'default'}/p/${process.env.IVY_SMOKE_PROJECT ?? 'default'}`;

type Shape = Record<string, string>;
let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return 'iso';
  return typeof value;
}

function matches(label: string, obj: Record<string, unknown>, shape: Shape) {
  const problems = Object.entries(shape)
    .filter(([key, types]) => !types.split('|').includes(typeOf(obj[key])) && !(types.includes('string') && typeOf(obj[key]) === 'iso'))
    .map(([key, types]) => `${key}: expected ${types}, got ${typeOf(obj[key])}`);
  const extra = Object.keys(obj).filter((key) => !(key in shape));
  if (extra.length) problems.push(`unexpected keys ${extra.join(', ')}`);
  check(label, problems.length === 0, problems.join('; '));
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const FUNCTION: Shape = {
  name: 'string', region: 'string', invocations: 'number', errors: 'number', error_rate: 'number',
  cold_starts: 'number', avg_ms: 'number', p50_ms: 'number', p95_ms: 'number', p99_ms: 'number', last_invoked: 'iso',
};
const INVOCATION: Shape = {
  trace_id: 'string', span_id: 'string', ts: 'iso', function: 'string', region: 'string', status: 'string',
  duration_ms: 'number', cold_start: 'boolean', request_id: 'string', trigger: 'string', http_method: 'string|null',
  http_path: 'string|null', http_status: 'number|null', error_type: 'string|null', error_message: 'string|null',
  memory_used_mb: 'number|null', memory_limit_mb: 'number|null', failure_phase: 'string|null', failure_kind: 'string|null',
  synthetic: 'boolean', init_duration_ms: 'number|null', deadline: 'string|null', last_seen: 'string|null',
};
const SPAN: Shape = {
  span_id: 'string', parent_span_id: 'string', name: 'string', kind: 'string', service: 'string', start: 'iso',
  end: 'iso', duration_ms: 'number', status_code: 'string', status_message: 'string', attributes: 'object',
  resource: 'object', events: 'array',
};
const ERROR_GROUP: Shape = {
  fingerprint: 'string', function: 'string', error_type: 'string', error_message: 'string', error_template: 'string',
  count: 'number', variants: 'number', top_messages: 'array', first_seen: 'iso', last_seen: 'iso', sample_trace_id: 'string',
};
const POINT: Shape = { ts: 'iso', invocations: 'number', errors: 'number', p95_ms: 'number' };

async function main() {
  const health = await get('/api/health');
  check('GET /api/health', health.status === 200 && health.body.ok === true && health.body.clickhouse === true);
  const config = await get('/api/config');
  check('GET /api/config', typeof config.body.version === 'string' && config.body.auth?.enabled === false);

  const functions = await get(`${P}/functions?since=7d`);
  check('GET /api/functions has items', functions.body.items?.length > 0);
  functions.body.items.forEach((item: any, i: number) => i === 0 && matches('  function shape', item, FUNCTION));

  const page1 = await get(`${P}/invocations?limit=5&since=7d`);
  check('GET /api/invocations returns 5', page1.body.items.length === 5 && typeof page1.body.next_cursor === 'string');
  matches('  invocation shape', page1.body.items[0], INVOCATION);
  const page2 = await get(`${P}/invocations?limit=5&since=7d&cursor=${page1.body.next_cursor}`);
  check(
    '  cursor continues strictly older',
    page2.body.items.length === 5 && page2.body.items[0].ts <= page1.body.items[4].ts &&
      !page2.body.items.some((a: any) => page1.body.items.some((b: any) => a.span_id === b.span_id)),
  );
  const sorted = [...page1.body.items, ...page2.body.items].every((item, i, all) => i === 0 || all[i - 1].ts >= item.ts);
  check('  sorted by ts desc', sorted);

  const errors = await get(`${P}/invocations?status=error&limit=50&since=7d`);
  check('  status=error filter', errors.body.items.length > 0 && errors.body.items.every((i: any) => i.status === 'error' && i.error_type));
  const fn = functions.body.items[0].name;
  const byFn = await get(`${P}/invocations?function=${encodeURIComponent(fn)}&since=7d`);
  check('  function filter', byFn.body.items.length > 0 && byFn.body.items.every((i: any) => i.function === fn));
  const sample = errors.body.items[0];
  for (const [what, q] of [['request id', sample.request_id], ['trace id', sample.trace_id], ['error message', sample.error_message.slice(0, 12).toUpperCase()]]) {
    const res = await get(`${P}/invocations?since=7d&q=${encodeURIComponent(q)}`);
    check(`  q matches ${what}`, res.body.items.some((i: any) => i.span_id === sample.span_id));
  }
  const httpItem = page1.body.items.concat(page2.body.items).find((i: any) => i.http_path);
  if (httpItem) {
    const res = await get(`${P}/invocations?since=7d&q=${encodeURIComponent(httpItem.http_path)}`);
    check('  q matches http path', res.body.items.some((i: any) => i.span_id === httpItem.span_id));
  }

  const trace = await get(`${P}/traces/${sample.trace_id}`);
  check('GET /api/traces/:id', trace.status === 200 && trace.body.trace_id === sample.trace_id && trace.body.spans.length > 0);
  matches('  span shape', trace.body.spans[0], SPAN);
  const root = trace.body.spans.find((s: any) => s.attributes['ivy.invocation'] === 'true');
  check('  root span is ERROR with exception event', root?.status_code === 'ERROR' && root.events.some((e: any) => e.name === 'exception'));
  check('  sorted by start', trace.body.spans.every((s: any, i: number, all: any[]) => i === 0 || all[i - 1].start <= s.start));
  const missing = await get(`${P}/traces/` + '0'.repeat(32));
  check('  unknown trace is 404', missing.status === 404);

  const groups = await get(`${P}/errors?since=7d`);
  check('GET /api/errors has items', groups.body.items.length > 0);
  matches('  error group shape', groups.body.items[0], ERROR_GROUP);
  const fnGroups = await get(`${P}/errors?since=7d&function=${encodeURIComponent(groups.body.items[0].function)}`);
  check('  function filter', fnGroups.body.items.every((g: any) => g.function === groups.body.items[0].function));

  for (const query of ['since=1h', 'since=24h', 'since=7d&bucket=1h', 'since=7d&bucket=1d', `since=24h&function=${encodeURIComponent(fn)}`]) {
    const series = await get(`${P}/stats/timeseries?${query}`);
    check(`GET /api/stats/timeseries?${query}`, series.status === 200 && series.body.items.length > 0, `${series.body.items?.length} points`);
    matches('  point shape', series.body.items[0], POINT);
  }

  const total24h = (await get(`${P}/functions?since=24h`)).body.items.reduce((s: number, f: any) => s + f.invocations, 0);
  const series24h = (await get(`${P}/stats/timeseries?since=24h&bucket=1h`)).body.items.reduce((s: number, p: any) => s + p.invocations, 0);
  check('  rollup totals are consistent with timeseries', series24h >= total24h, `${series24h} >= ${total24h}`);

  const bad = await get(`${P}/invocations?status=meh`);
  check('bad params are 400', bad.status === 400 && typeof bad.body.error === 'string');

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
