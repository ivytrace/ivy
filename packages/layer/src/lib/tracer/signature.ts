import type { AttrValue, Attributes, Span } from './span.js';

const str = (v: AttrValue | undefined): string | undefined => (typeof v === 'string' && v ? v : Array.isArray(v) && v.length ? v.join(',') : undefined);
const num = (v: AttrValue | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[^/]*\d)[A-Za-z0-9_-]{16,})$/i;

/** `/users/42/orders/9f1c…` → `/users/{id}/orders/{id}`: numeric, UUID, long hex and long mixed IDs. */
export function routeTemplate(path: string): string {
  const clean = path.split('?')[0].split('#')[0] || '/';
  return clean
    .split('/')
    .map((seg) => (seg && ID_SEGMENT.test(seg) ? '{id}' : seg))
    .join('/');
}

function pathOf(url: AttrValue | undefined): string {
  const s = str(url);
  if (!s) return '/';
  const m = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(s);
  return m?.[1] || '/';
}

const LLM_HOSTS = /(^|\.)(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.groq\.com|api\.cohere\.(ai|com)|api\.deepseek\.com|api\.together\.xyz|api\.fireworks\.ai|openrouter\.ai|api\.x\.ai)$|^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$|\.openai\.azure\.com$/i;

const LLM_PATHS = /\/(chat\/completions|completions|messages|responses|embeddings|generateContent|streamGenerateContent)$|\/model\/[^/]+\/(converse|converse-stream|invoke|invoke-with-response-stream)$/;

/** A call to a model provider (or a gateway with the providers' paths), by host or path. */
export function isLlmCall(host: string | undefined, url: string | undefined): boolean {
  if (host && LLM_HOSTS.test(host)) return true;
  const path = url ? pathOf(url).replace(/:[A-Za-z]+$/, (m) => `/${m.slice(1)}`) : '';
  return LLM_PATHS.test(path);
}

/** Provider, model and operation of an LLM span from the OTel bridge (AI SDK `ai.*` or GenAI attributes). */
function llmIdentity(a: Attributes): string | undefined {
  const model = str(a['gen_ai.request.model']) ?? str(a['ai.model.id']) ?? str(a['gen_ai.response.model']);
  if (!model) return undefined;
  const provider = str(a['gen_ai.provider.name']) ?? str(a['gen_ai.system']) ?? str(a['ai.model.provider']) ?? '';
  const operation = str(a['ai.operationId']) ?? str(a['gen_ai.operation.name']) ?? '';
  return `llm ${operation} ${provider} ${model}`;
}

/**
 * What makes calls "the same" for collapsing: AWS service + operation + target (table, bucket,
 * queue, topic, function, bus), an LLM's operation + provider + model, HTTP method + host + route
 * template, or else the span name.
 */
export function signatureOf(span: Span): string {
  const a = span.attributes;
  const llm = llmIdentity(a);
  if (llm) return llm;
  if (a['rpc.system'] === 'aws-api') {
    const target =
      str(a['aws.dynamodb.table_names']) ??
      str(a['aws.s3.bucket']) ??
      str(a['messaging.destination.name']) ??
      str(a['faas.invoked_name']) ??
      str(a['aws.eventbridge.bus']) ??
      '';
    return `${str(a['rpc.service'])}.${str(a['rpc.method'])} ${target}`.trim();
  }
  const method = str(a['http.request.method']);
  if (method) return `${method} ${str(a['server.address']) ?? ''} ${routeTemplate(pathOf(a['url.full']))}`;
  return span.name;
}

/** Attributes copied from the first collapsed call onto the summary span. */
export const REPRESENTATIVE_ATTRIBUTES = [
  'rpc.system',
  'rpc.service',
  'rpc.method',
  'cloud.region',
  'aws.dynamodb.table_names',
  'aws.s3.bucket',
  'messaging.system',
  'messaging.destination.name',
  'faas.invoked_name',
  'faas.invoked_region',
  'aws.eventbridge.bus',
  'http.request.method',
  'server.address',
  'server.port',
  'otel.scope.name',
  'gen_ai.provider.name',
  'gen_ai.system',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'ai.model.id',
  'ai.model.provider',
  'ai.operationId',
];

/** Input and output tokens of an LLM span (bridge attributes), if any. */
export function spanTokens(a: Attributes): { input?: number; output?: number } {
  return {
    input: num(a['gen_ai.usage.input_tokens']) ?? num(a['ai.usage.inputTokens']) ?? num(a['ai.usage.promptTokens']) ?? num(a['gen_ai.usage.prompt_tokens']),
    output: num(a['gen_ai.usage.output_tokens']) ?? num(a['ai.usage.outputTokens']) ?? num(a['ai.usage.completionTokens']) ?? num(a['gen_ai.usage.completion_tokens']),
  };
}

const lastNumber = (text: string, re: RegExp): number | undefined => {
  let out: number | undefined;
  for (const m of text.matchAll(re)) out = Number(m[1]);
  return out;
};

/**
 * Tokens from a model provider's response body (a plain HTTP span, e.g. without the OTel bridge):
 * OpenAI `usage.prompt_tokens`, Anthropic `input_tokens`, Bedrock Converse `inputTokens`. The last
 * value wins, which suits streamed responses that repeat a running total.
 */
export function bodyTokens(text: string): { input?: number; output?: number } {
  return {
    input: lastNumber(text, /"(?:prompt_tokens|input_tokens|inputTokens|promptTokenCount)"\s*:\s*(\d+)/g),
    output: lastNumber(text, /"(?:completion_tokens|output_tokens|outputTokens|candidatesTokenCount)"\s*:\s*(\d+)/g),
  };
}
