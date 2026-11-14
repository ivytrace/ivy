/**
 * End-to-end check of workspaces and projects against a running compose stack with OIDC on in
 * multi-workspace mode. Serves a throwaway OIDC provider itself (discovery, JWKS, userinfo) and
 * signs tokens for two users. See docs/implementation/workspaces-projects.md, "Verification".
 *
 *   IVY_E2E_ISSUER_PORT=14400 \
 *   IVY_OIDC_ISSUER=http://host.docker.internal:14400 IVY_OIDC_CLIENT_ID=ivy IVY_SINGLE_TENANT=0 IVY_SECRET_KEY=e2e \
 *   IVY_API_PORT=13000 IVY_OTLP_HTTP_PORT=14318 IVY_CLICKHOUSE_HTTP_PORT=18123 \
 *     docker compose -p ivy-e2e -f deploy/docker-compose.yml up -d --build --wait
 *   pnpm --filter @ivy/api exec tsx scripts/e2e-workspaces.ts http://localhost:13000 http://localhost:14318
 *
 * The provider must be reachable from the API container at IVY_OIDC_ISSUER and from this script.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const [api = 'http://localhost:13000', ingest = 'http://localhost:14318'] = process.argv.slice(2).filter((a) => a !== '--');
const port = Number(process.env.IVY_E2E_ISSUER_PORT ?? 14400);
const issuer = process.env.IVY_E2E_ISSUER ?? `http://host.docker.internal:${port}`;

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
}

// --- OIDC provider -------------------------------------------------------------------------
const keys = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' }] };
const userinfo = new Map<string, object>();
const provider = http.createServer((req, res) => {
  const send = (status: number, body: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (req.url === '/.well-known/openid-configuration') return send(200, { issuer, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo` });
  if (req.url === '/jwks') return send(200, jwks);
  if (req.url === '/userinfo') {
    const info = userinfo.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return info ? send(200, info) : send(401, { error: 'invalid_token' });
  }
  send(404, {});
});
await new Promise<void>((resolve) => provider.listen(port, '0.0.0.0', resolve));

const run = randomBytes(3).toString('hex');
interface User { sub: string; email: string; token: string }
async function user(name: string): Promise<User> {
  const sub = `idn_${name}_${run}`;
  const email = `${name}-${run}@example.com`;
  const token = await new SignJWT({ client_id: 'ivy', email, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
    .setIssuer(issuer)
    .setAudience('ivy')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
  userinfo.set(token, { sub, email, email_verified: true });
  return { sub, email, token };
}

async function call(u: User, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(api + path, {
    method,
    headers: { authorization: `Bearer ${u.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --- OTLP ----------------------------------------------------------------------------------
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
function invocation(fn: string, forged: Record<string, string> = {}) {
  const traceId = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + hex(12);
  const start = BigInt(Date.now()) * 1_000_000n;
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', fn), attr('faas.name', fn), attr('cloud.region', 'eu-west-1'), ...Object.entries(forged).map(([k, v]) => attr(k, v))] },
        scopeSpans: [
          {
            scope: { name: 'e2e' },
            spans: [
              {
                traceId,
                spanId: hex(8),
                name: fn,
                kind: 2,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(start + 42_000_000n),
                attributes: [attr('ivy.invocation', 'true'), attr('faas.invocation_id', hex(8))],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  return { traceId, body };
}

async function send(key: string, body: object) {
  const res = await fetch(`${ingest}/v1/traces`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.status;
}

// --- Scenario ------------------------------------------------------------------------------
try {
  const alice = await user('alice');
  const bob = await user('bob');

  check('config reports multi-workspace mode', (await call(alice, 'GET', '/api/config')).body?.workspaces?.multi === true);
  const personal = await call(alice, 'GET', '/api/workspaces');
  check('first request creates a personal workspace', personal.body?.items?.length === 1 && personal.body.items[0].role === 'owner', personal.body);

  const setups: Record<string, { owner: User; projects: Record<string, { id: string; key: string }> }> = {};
  for (const [owner, ws] of [[alice, `alpha-${run}`], [bob, `beta-${run}`]] as const) {
    const created = await call(owner, 'POST', '/api/workspaces', { name: ws, slug: ws });
    check(`create workspace ${ws}`, created.status === 201, created.body);
    setups[ws] = { owner, projects: {} };
    for (const env of ['prod', 'staging']) {
      const slug = `api-${env}`;
      const project = await call(owner, 'POST', `/api/w/${ws}/projects`, { name: `API (${env})`, slug });
      const key = await call(owner, 'POST', `/api/w/${ws}/p/${slug}/keys`, { name: 'e2e' });
      check(`  project ${ws}/${slug} with a key`, project.status === 201 && key.status === 201 && /^ivy_/.test(key.body?.key), key.body);
      setups[ws].projects[slug] = { id: project.body.id, key: key.body.key };
    }
  }

  const alpha = `alpha-${run}`;
  const beta = `beta-${run}`;
  const traces: Record<string, string> = {};
  for (const [ws, setup] of Object.entries(setups)) {
    for (const [slug, p] of Object.entries(setup.projects)) {
      // Each span claims to belong to the other workspace's project: the router/collector must overwrite that.
      const other = Object.values(setups[ws === alpha ? beta : alpha].projects)[0].id;
      const { traceId, body } = invocation(`${ws}-${slug}-fn`, { 'ivy.tenant_id': 'ten_forged', 'ivy.project_id': other });
      traces[`${ws}/${slug}`] = traceId;
      check(`ingest into ${ws}/${slug}`, (await send(p.key, body)) === 200);
    }
  }
  check('ingest with an unknown key is 401', (await send('ivy_nope', invocation('x').body)) === 401);

  await new Promise((r) => setTimeout(r, 6000));

  for (const [ws, setup] of Object.entries(setups)) {
    const u = setup.owner;
    for (const slug of Object.keys(setup.projects)) {
      const fns = await call(u, 'GET', `/api/w/${ws}/p/${slug}/functions?since=1h`);
      const names = fns.body?.items?.map((f: { name: string }) => f.name);
      check(`${ws}/${slug} functions: only its own`, JSON.stringify(names) === JSON.stringify([`${ws}-${slug}-fn`]), names);
      const trace = await call(u, 'GET', `/api/w/${ws}/p/${slug}/traces/${traces[`${ws}/${slug}`]}`);
      const resource = trace.body?.spans?.[0]?.resource ?? {};
      check(`  forged ivy.project_id/ivy.tenant_id overwritten`, resource['ivy.project_id'] === setup.projects[slug].id && resource['ivy.tenant_id'] !== 'ten_forged', resource);
      const inv = await call(u, 'GET', `/api/w/${ws}/p/${slug}/invocations?since=1h`);
      check(`  invocations: 1`, inv.body?.items?.length === 1, inv.body?.items?.length);
    }
    const [a, b] = Object.keys(setup.projects);
    check(`${ws}: a trace isn't visible under the sibling project`, (await call(u, 'GET', `/api/w/${ws}/p/${b}/traces/${traces[`${ws}/${a}`]}`)).status === 404);
    const all = await call(u, 'GET', `/api/w/${ws}/functions?since=1h`);
    const labelled = all.body?.items?.map((f: { name: string; project: string }) => `${f.project}:${f.name}`).sort();
    check(`${ws}: workspace-wide functions cover both projects`, JSON.stringify(labelled) === JSON.stringify([`${a}:${ws}-${a}-fn`, `${b}:${ws}-${b}-fn`]), labelled);
  }

  check('bob gets 404 on alpha', (await call(bob, 'GET', `/api/w/${alpha}/p/api-prod/functions`)).status === 404);
  check('bob gets 404 on alpha by ID', (await call(bob, 'GET', `/api/w/${(await call(alice, 'GET', `/api/w/${alpha}`)).body.id}`)).status === 404);

  const invite = await call(alice, 'POST', `/api/w/${alpha}/invitations`, { email: bob.email.toUpperCase() });
  check('alice invites bob', invite.status === 201 && typeof invite.body?.url === 'string', invite.body);
  const token = String(invite.body?.url).split('/invite/')[1];
  check('bob accepts the invitation', (await call(bob, 'POST', `/api/invitations/${token}/accept`)).status === 200);
  const bobView = await call(bob, 'GET', `/api/w/${alpha}/p/api-prod/functions?since=1h`);
  check('bob now sees alpha data', bobView.body?.items?.length === 1, bobView.body);
  check('bob (member) cannot rename alpha', (await call(bob, 'PATCH', `/api/w/${alpha}`, { name: 'x' })).status === 403);
  check('the invitation is single use', (await call(bob, 'POST', `/api/invitations/${token}/accept`)).status === 410);
  check('alice still gets 404 on beta', (await call(alice, 'GET', `/api/w/${beta}/errors`)).status === 404);

  const archived = await call(alice, 'PATCH', `/api/w/${alpha}/p/api-staging`, { archived: true });
  check('archive a project', archived.body?.archived === true);
  const staleKey = await call(alice, 'POST', `/api/w/${alpha}/p/api-staging/keys`, {});
  check('no new keys for an archived project', staleKey.status === 409);
} finally {
  provider.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
