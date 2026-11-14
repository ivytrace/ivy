import http from 'node:http';

export interface FakeReply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * A fake of the Slack endpoints Ivy calls, for tests: `POST /api/oauth.v2.access` and incoming
 * webhooks at `POST /hooks/<name>`. Never talks to Slack.
 */
export async function startFakeSlack() {
  const posts: { hook: string; body: any }[] = [];
  const oauthCalls: URLSearchParams[] = [];
  /** Replies to hand out per hook, in order; afterwards 200 `ok`. */
  const queued = new Map<string, FakeReply[]>();
  let oauthReply: (params: URLSearchParams) => FakeReply = () => ({ status: 200, body: JSON.stringify(okOauth('main')) });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let reply: FakeReply = { status: 404, body: 'not found' };
      if (req.method === 'POST' && req.url === '/api/oauth.v2.access') {
        const params = new URLSearchParams(text);
        oauthCalls.push(params);
        reply = oauthReply(params);
      } else if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
        const hook = req.url.slice('/hooks/'.length);
        posts.push({ hook, body: JSON.parse(text) });
        reply = queued.get(hook)?.shift() ?? { status: 200, body: 'ok' };
      }
      res.writeHead(reply.status, { 'content-type': 'text/plain', ...reply.headers }).end(reply.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  function okOauth(hook: string, channel = '#alerts', channelId = 'C0123') {
    return {
      ok: true,
      access_token: 'xoxb-test',
      token_type: 'bot',
      scope: 'incoming-webhook',
      team: { id: 'T0123', name: 'Acme' },
      incoming_webhook: { channel, channel_id: channelId, configuration_url: 'https://acme.slack.com/services/B1', url: `${base}/hooks/${hook}` },
    };
  }

  return {
    base,
    apiUrl: `${base}/api`,
    hookUrl: (name: string) => `${base}/hooks/${name}`,
    posts,
    oauthCalls,
    okOauth,
    setOauthReply(fn: (params: URLSearchParams) => FakeReply) {
      oauthReply = fn;
    },
    queue(hook: string, ...replies: FakeReply[]) {
      queued.set(hook, [...(queued.get(hook) ?? []), ...replies]);
    },
    reset() {
      posts.length = 0;
      oauthCalls.length = 0;
      queued.clear();
      oauthReply = () => ({ status: 200, body: JSON.stringify(okOauth('main')) });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
