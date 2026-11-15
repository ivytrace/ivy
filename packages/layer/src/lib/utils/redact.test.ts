import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_KEYS } from '../config/config.js';
import { capString, createKeyMatcher, redactHeaders, redactText, redactUrl, serialize, serializeBody, stringLimit } from './redact.js';

const isSecret = createKeyMatcher(DEFAULT_REDACT_KEYS.split(','));

describe('createKeyMatcher', () => {
  it('matches case-insensitively, ignoring - and _', () => {
    expect(isSecret('Password')).toBe(true);
    expect(isSecret('x-api-key')).toBe(true);
    expect(isSecret('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isSecret('X-Amz-Security-Token')).toBe(true);
    expect(isSecret('Set-Cookie')).toBe(true);
    expect(isSecret('username')).toBe(false);
  });

  it.each([
    'max_tokens',
    'maxTokens',
    'max_output_tokens',
    'max_new_tokens',
    'max_completion_tokens',
    'input_tokens',
    'output_tokens',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'reasoning_tokens',
    'cached_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cacheReadInputTokens',
    'budget_tokens',
    'promptTokenCount',
    'maxTokenCount',
    'inputTextTokenCount',
    'prompt_tokens_details',
    'completion_tokens_details',
    'x-amzn-bedrock-input-token-count',
    'X-Amzn-Bedrock-Output-Token-Count',
  ])('keeps the token count %s, whatever its value', (key) => {
    expect(isSecret(key, 812)).toBe(false);
    expect(isSecret(key, '812')).toBe(false);
    expect(isSecret(key, { cached_tokens: 0 })).toBe(false);
  });

  it.each(['token', 'Token', 'access_token', 'accessToken', 'id_token', 'idToken', 'refresh_token', 'refreshTokens', 'sessionToken', 'X-Amz-Security-Token', 'api_token', 'apiTokens', 'x-auth-token', 'authTokens', 'csrfToken', 'bearer_tokens', 'tokenSecret'])(
    'still redacts the credential %s',
    (key) => {
      expect(isSecret(key, 'abc')).toBe(true);
      expect(isSecret(key, ['abc'])).toBe(true);
      expect(isSecret(key)).toBe(true);
    },
  );

  it('keeps numbers and booleans for keys that only match "token", but not for other secrets', () => {
    expect(isSecret('tokenLimit', 4096)).toBe(false);
    expect(isSecret('useToken', true)).toBe(false);
    expect(isSecret('tokenLimit', '4096')).toBe(true);
    expect(isSecret('cardNumber', 4111111111111111)).toBe(true);
    expect(isSecret('cvv', 123)).toBe(true);
    expect(isSecret('password', 1234)).toBe(true);
    expect(isSecret('tokenPassword', 1234)).toBe(true);
  });
});

describe('serialize', () => {
  it('redacts keys at any depth', () => {
    const { text } = serialize({ a: { b: [{ password: 'x', ok: 1 }] }, Authorization: 'Bearer y' }, 16384, isSecret);
    expect(JSON.parse(text)).toEqual({ a: { b: [{ password: '[redacted]', ok: 1 }] }, Authorization: '[redacted]' });
  });

  it('handles cycles, bigint, buffers, errors and streams', () => {
    const o: any = { n: 10n, buf: Buffer.from('{"x":1}'), bin: Buffer.from([0xff, 0xfe]), err: new Error('boom') };
    o.self = o;
    o.stream = { pipe() {}, on() {} };
    const parsed = JSON.parse(serialize(o, 16384, isSecret).text);
    expect(parsed).toMatchObject({ n: '10', buf: { x: 1 }, bin: '[binary 2 bytes]', err: { name: 'Error', message: 'boom' }, self: '[circular]', stream: '[stream]' });
  });

  it('caps by bytes and reports truncation', () => {
    const r = serialize({ s: 'x'.repeat(100) }, 50, isSecret);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/…\[truncated 58 bytes\]$/);
    expect(Buffer.byteLength(r.text.split('…')[0])).toBe(50);
  });

  it('shrinks long strings so an oversized event stays valid JSON', () => {
    const body = JSON.stringify({ cartId: 'cart_91', items: Array.from({ length: 400 }, (_, i) => ({ sku: `SKU-${i}`, qty: 1 })) });
    const event = {
      version: '2.0',
      headers: { host: 'api.example.com', authorization: 'Bearer x', 'user-agent': 'a'.repeat(300) },
      requestContext: { http: { method: 'POST', path: '/orders' } },
      body,
      isBase64Encoded: false,
    };
    const r = serialize(event, 4096, isSecret);
    expect(r.truncated).toBe(true);
    const [json, note] = r.text.split(/(?=…\[truncated \d+ bytes\]$)/);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(4096);
    expect(note).toMatch(/^…\[truncated \d+ bytes\]$/);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({ version: '2.0', requestContext: event.requestContext, isBase64Encoded: false });
    expect(parsed.headers).toMatchObject({ host: 'api.example.com', authorization: '[redacted]', 'user-agent': 'a'.repeat(300) });
    expect(parsed.body).toMatch(/^\{"cartId":"cart_91","items":\[.*…\[\+\d+ chars\]$/);
  });

  it('caps long arrays when cutting strings is not enough', () => {
    const r = serialize({ items: Array.from({ length: 2000 }, (_, i) => ({ id: i })) }, 2048, isSecret);
    const parsed = JSON.parse(r.text.replace(/…\[truncated \d+ bytes\]$/, ''));
    expect(parsed.items).toHaveLength(21);
    expect(parsed.items[20]).toBe('…[+1980 items]');
  });

  it('picks the largest string limit that saves enough', () => {
    expect(stringLimit([1000, 500, 100], 300)).toBe(1000 - 300 - 16);
    expect(stringLimit([1000, 900], 300)).toBe(Math.floor((1900 - 300) / 2) - 16);
    expect(stringLimit([100], 300)).toBe(64);
  });

  it('does not split multi-byte characters', () => {
    const r = capString('€'.repeat(10), 8);
    expect(r.text.startsWith('€€…')).toBe(true);
    expect(r.text).toContain('[truncated 24 bytes]');
  });

  it('keeps token counts in LLM request and response bodies', () => {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 512 },
      usage: { input_tokens: 812, output_tokens: 24, cache_read_input_tokens: 0 },
      openai: { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } },
      converse: { usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } },
      auth: { token: 'secret', accessToken: 'a', cardNumber: 4111111111111111, cvv: 123 },
    };
    expect(JSON.parse(serialize(body, 16384, isSecret).text)).toEqual({
      ...body,
      auth: { token: '[redacted]', accessToken: '[redacted]', cardNumber: '[redacted]', cvv: '[redacted]' },
    });
  });

  it('returns empty text for undefined', () => {
    expect(serialize(undefined, 10, isSecret)).toEqual({ text: '', truncated: false });
  });
});

describe('serializeBody', () => {
  it('parses JSON bodies to redact', () => {
    expect(serializeBody('{"token":"t","a":1}', 'application/json', 1000, isSecret).text).toBe('{"token":"[redacted]","a":1}');
  });
  it('falls back to regex redaction for broken JSON and forms', () => {
    expect(redactText('{"password": "abc", "user": "u", "tok', isSecret)).toBe('{"password": "[redacted]", "user": "u", "tok');
    expect(serializeBody('user=a&password=b', 'application/x-www-form-urlencoded', 1000, isSecret).text).toBe('user=a&password=%5Bredacted%5D');
  });
  it('keeps token counts in broken JSON', () => {
    expect(redactText('{"max_tokens": 100, "tokenLimit": 5, "token": "t", "cvv": 123, "usage": {"input_tok', isSecret)).toBe(
      '{"max_tokens": 100, "tokenLimit": 5, "token": "[redacted]", "cvv": "[redacted]", "usage": {"input_tok',
    );
  });
});

describe('redactUrl / redactHeaders', () => {
  it('redacts query params', () => {
    expect(redactUrl('https://x.io/a?api_key=1&page=2#f', isSecret)).toBe('https://x.io/a?api_key=%5Bredacted%5D&page=2');
    expect(redactUrl('https://x.io/a', isSecret)).toBe('https://x.io/a');
  });
  it('redacts headers', () => {
    expect(JSON.parse(redactHeaders({ Authorization: 'x', 'Content-Type': 'json', accept: ['a', 'b'] }, isSecret))).toEqual({
      authorization: '[redacted]',
      'content-type': 'json',
      accept: 'a, b',
    });
    expect(
      JSON.parse(redactHeaders({ 'X-Amzn-Bedrock-Input-Token-Count': '812', 'x-amzn-bedrock-output-token-count': '24', 'x-auth-token': 't', 'X-Amz-Security-Token': 's' }, isSecret)),
    ).toEqual({ 'x-amzn-bedrock-input-token-count': '812', 'x-amzn-bedrock-output-token-count': '24', 'x-auth-token': '[redacted]', 'x-amz-security-token': '[redacted]' });
  });
  it('keeps token-count query params', () => {
    expect(redactUrl('https://x.io/a?max_tokens=10&token=abc', isSecret)).toBe('https://x.io/a?max_tokens=10&token=%5Bredacted%5D');
  });
});
