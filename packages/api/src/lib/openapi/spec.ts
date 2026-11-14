import { schemas } from './schemas.js';

/**
 * Hand-maintained OpenAPI 3.1 document of the public API (docs/implementation/api.md is the prose
 * version). spec.test.ts fails when a route in createApp is missing here, or the reverse.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const error = (description: string) => json(ref('Error'), description);
const body = (name: string) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });

const query = (name: string, description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
  name, in: 'query', description, schema,
});
const path = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });

const range = [
  query('since', 'Relative range: a number plus m, h or d (e.g. 15m, 1h, 24h, 7d). Default 24h.', { type: 'string', pattern: '^\\d+[mhd]$', default: '24h' }),
  query('from', 'Range start (ISO 8601); overrides since.', { type: 'string', format: 'date-time' }),
  query('to', 'Range end (ISO 8601). Default now.', { type: 'string', format: 'date-time' }),
];
const fn = query('function', 'Exact function name.');
const accountId = path('id', 'Connection ID (not the AWS account ID).');
const bad = { 400: error('Invalid parameters') };
const PUBLIC: never[] = [];

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Ivy API',
    version: '0.1.0',
    description:
      'Ivy traces AWS Lambda functions. This API serves the dashboard and agents. Timestamps are ISO 8601 (UTC, ms ' +
      'precision); durations are milliseconds. Agents can also use the remote MCP server at `/mcp` (Streamable HTTP; ' +
      'same data, compact text answers), or `GET /api/traces/{traceId}?format=text` for an LLM-friendly trace.',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'OIDC access token for the API audience, from the issuer in `IVY_OIDC_ISSUER`. Tokens for the MCP audience ' +
          '(`IVY_MCP_RESOURCE`) are only accepted on `/mcp`. Self-hosted setups without OIDC run without auth: no token ' +
          'is needed and `GET /api/config` reports `auth.enabled: false`.',
      },
      eventSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'x-ivy-event-secret',
        description: 'Per-connection secret of the EventBridge API destination.',
      },
    },
    schemas,
  },
  tags: [
    { name: 'Traces', description: 'Functions, invocations, traces, errors and stats.' },
    { name: 'Auto-trace', description: 'AWS account connections and the tracing state of their functions (auto-trace.md).' },
    { name: 'Meta', description: 'Health, configuration and this document.' },
  ],
  paths: {
    '/api/health': {
      get: { tags: ['Meta'], summary: 'Health check', operationId: 'getHealth', security: PUBLIC, responses: { 200: json(ref('Health')) } },
    },
    '/api/config': {
      get: { tags: ['Meta'], summary: 'Server configuration for the UI', operationId: 'getConfig', security: PUBLIC, responses: { 200: json(ref('Config')) } },
    },
    '/api/openapi.json': {
      get: { tags: ['Meta'], summary: 'This OpenAPI document', operationId: 'getOpenApi', security: PUBLIC, responses: { 200: json({ type: 'object' }) } },
    },
    '/api/docs': {
      get: {
        tags: ['Meta'], summary: 'API reference page (Scalar)', operationId: 'getApiDocs', security: PUBLIC,
        responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } },
      },
    },
    '/api/functions': {
      get: {
        tags: ['Traces'], summary: 'Function overview for the range', operationId: 'listFunctions',
        parameters: range, responses: { 200: json(ref('FunctionList')), ...bad },
      },
    },
    '/api/invocations': {
      get: {
        tags: ['Traces'], summary: 'Invocations, newest first', operationId: 'listInvocations',
        parameters: [
          ...range, fn,
          query('status', 'Only ok or error.', { type: 'string', enum: ['ok', 'error'] }),
          query('q', 'Free text: request ID or trace ID (exact), or text in the error message or HTTP path.'),
          query('limit', 'Page size.', { type: 'integer', minimum: 1, maximum: 500, default: 50 }),
          query('cursor', 'Opaque cursor from next_cursor.'),
        ],
        responses: { 200: json(ref('InvocationList')), ...bad },
      },
    },
    '/api/traces/{traceId}': {
      get: {
        tags: ['Traces'], summary: 'All spans of a trace', operationId: 'getTrace',
        description: 'Spans sorted by start time. With `format=text`, a compact text tree for LLMs (see mcp.md and the @ivy/format package).',
        parameters: [
          path('traceId', '32 hex characters.'),
          query('format', '`json` (default) or `text`.', { type: 'string', enum: ['json', 'text'], default: 'json' }),
          query('detail', 'Text format only: summary, normal or full.', { type: 'string', enum: ['summary', 'normal', 'full'], default: 'normal' }),
          query('max_tokens', 'Text format only: approximate size budget; 0 for no limit.', { type: 'integer', minimum: 0, default: 4000 }),
        ],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: ref('Trace') }, 'text/plain': { schema: { type: 'string' } } },
          },
          404: error('Trace not found'),
        },
      },
    },
    '/api/errors': {
      get: {
        tags: ['Traces'], summary: 'Error groups (function + error type + normalized message)', operationId: 'listErrorGroups',
        parameters: [...range, fn], responses: { 200: json(ref('ErrorGroupList')), ...bad },
      },
    },
    '/api/stats/timeseries': {
      get: {
        tags: ['Traces'], summary: 'Invocations, errors and p95 per bucket', operationId: 'getTimeseries',
        parameters: [
          ...range, fn,
          query('bucket', 'Bucket size; default keeps about 100 points or fewer.', { type: 'string', enum: ['1m', '5m', '15m', '1h', '1d'] }),
        ],
        responses: { 200: json(ref('Timeseries')), ...bad },
      },
    },
    '/api/aws/setup': {
      get: { tags: ['Auto-trace'], summary: 'Server-side configuration for the connect flow', operationId: 'getAwsSetup', responses: { 200: json(ref('AwsSetup')) } },
    },
    '/api/aws/template.yaml': {
      get: {
        tags: ['Auto-trace'], summary: 'CloudFormation template', operationId: 'getAwsTemplate',
        parameters: [
          query('account', "Connection ID: fills in that connection's parameters as defaults."),
          query('download', '1 adds content-disposition: attachment.'),
        ],
        responses: { 200: { description: 'Template', content: { 'text/yaml': { schema: { type: 'string' } } } }, 404: error('Not found') },
      },
    },
    '/api/aws/events': {
      post: {
        tags: ['Auto-trace'], summary: 'EventBridge API destination target', operationId: 'postAwsEvent',
        description: 'Syncs the region of the event. Authenticated with the per-connection event secret, not user auth.',
        security: [{ eventSecret: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 202: { description: 'Accepted' }, 401: error('Missing secret'), 403: error('Wrong secret') },
      },
    },
    '/api/aws/accounts': {
      get: { tags: ['Auto-trace'], summary: 'Connected AWS accounts', operationId: 'listAwsAccounts', responses: { 200: json(ref('AwsAccountList')) } },
      post: {
        tags: ['Auto-trace'], summary: 'Start connecting an AWS account', operationId: 'createAwsAccount',
        requestBody: body('AwsAccountCreate'),
        responses: { 201: json(ref('AwsAccount'), 'Created (status pending)'), ...bad, 409: error('Account already connected') },
      },
    },
    '/api/aws/accounts/{id}': {
      get: {
        tags: ['Auto-trace'], summary: 'One connection', operationId: 'getAwsAccount',
        parameters: [accountId], responses: { 200: json(ref('AwsAccount')), 404: error('Not found') },
      },
      patch: {
        tags: ['Auto-trace'], summary: 'Update a connection (starts a sync when connected)', operationId: 'updateAwsAccount',
        parameters: [accountId], requestBody: body('AwsAccountUpdate'),
        responses: { 200: json(ref('AwsAccount')), ...bad, 404: error('Not found') },
      },
      delete: {
        tags: ['Auto-trace'], summary: 'Remove a connection', operationId: 'deleteAwsAccount',
        description: 'Removes the layer from all functions first unless detach=false (or the account is pending).',
        parameters: [accountId, query('detach', 'Detach the layer first (default true).', { type: 'string', enum: ['true', 'false'] })],
        responses: { 200: json(ref('AwsDeleteResult')), 404: error('Not found') },
      },
    },
    '/api/aws/accounts/{id}/verify': {
      post: {
        tags: ['Auto-trace'], summary: 'Try AssumeRole; on success the account becomes connected', operationId: 'verifyAwsAccount',
        parameters: [accountId], responses: { 200: json(ref('AwsVerifyResult')), 404: error('Not found') },
      },
    },
    '/api/aws/accounts/{id}/sync': {
      post: {
        tags: ['Auto-trace'], summary: 'Sync the functions of a connection', operationId: 'syncAwsAccount',
        parameters: [accountId, query('wait', '1 waits for the sync to finish.')],
        responses: { 202: json({ type: 'object', properties: { started: { type: 'boolean' } } }, 'Started'), 404: error('Not found'), 409: error('Account pending') },
      },
    },
    '/api/aws/functions': {
      get: {
        tags: ['Auto-trace'], summary: 'Tracing state of every function in the connected accounts', operationId: 'listAwsFunctions',
        parameters: [query('account', '12-digit AWS account ID.')], responses: { 200: json(ref('AwsFunctionList')) },
      },
    },
    '/api/aws/functions/{accountId}/{region}/{name}': {
      put: {
        tags: ['Auto-trace'], summary: 'Turn tracing of one function on or off', operationId: 'updateAwsFunction',
        description: 'Stores the setting, then attaches or detaches right away. If applying fails the setting is kept and the next sync retries.',
        parameters: [path('accountId', '12-digit AWS account ID.'), path('region', 'AWS region.'), path('name', 'Function name.')],
        requestBody: body('AwsFunctionUpdate'),
        responses: { 200: json(ref('AwsFunctionUpdateResult')), ...bad, 404: error('Not found') },
      },
    },
  },
};
