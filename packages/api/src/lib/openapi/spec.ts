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
const ws = path('workspace', 'Workspace slug or ID.');
const prj = path('project', 'Project slug or ID within the workspace.');
const token = path('token', 'The token from the invite link.');
const sub = path('sub', "The member's OIDC subject.");
const bad = { 400: error('Invalid parameters') };
const notFound = { 404: error('Not found (also: workspace you are not a member of)') };
const owner = { 403: error('Only workspace owners can do this') };
const single = { 403: error('Single-workspace mode') };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const PUBLIC: never[] = [];

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Ivy API',
    version: '0.1.0',
    description:
      'Ivy traces AWS Lambda functions. This API serves the dashboard and agents. Timestamps are ISO 8601 (UTC, ms ' +
      'precision); durations are milliseconds. Agents can also use the remote MCP server at `/mcp` (Streamable HTTP; ' +
      'same data, compact text answers), or `GET /api/w/{workspace}/p/{project}/traces/{traceId}?format=text` for an LLM-friendly trace.',
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
    { name: 'Workspaces', description: 'Workspaces, members and invitations (workspaces-projects.md).' },
    { name: 'Projects', description: 'Projects and their ingest keys.' },
    { name: 'Traces', description: 'Functions, invocations, traces, errors and stats, per project (or workspace-wide).' },
    { name: 'Auto-trace', description: 'AWS account connections, opt-in tracing rules and the state of their functions (auto-trace.md).' },
    { name: 'Alerts', description: 'Slack alerts per project, the weekly email digest and your notification settings (alerts.md).' },
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
    '/api/workspaces': {
      get: { tags: ['Workspaces'], summary: "The caller's workspaces", operationId: 'listWorkspaces', responses: { 200: json(ref('WorkspaceList')) } },
      post: {
        tags: ['Workspaces'], summary: 'Create a workspace (with a default project)', operationId: 'createWorkspace',
        description: 'The slug is generated from the name (-2, -3, … on collisions). 403 in single-workspace mode.',
        requestBody: body('WorkspaceCreate'), responses: { 201: json(ref('Workspace'), 'Created'), ...bad, 403: error('Single-workspace mode'), 409: error('Slug taken') },
      },
    },
    '/api/invitations/{token}': {
      get: {
        tags: ['Workspaces'], summary: 'What an invite link is for', operationId: 'getInvitation',
        parameters: [token], responses: { 200: json(ref('InvitationInfo')), 403: error('Auth is off'), 404: error('Unknown link') },
      },
    },
    '/api/invitations/{token}/accept': {
      post: {
        tags: ['Workspaces'], summary: 'Accept an invitation', operationId: 'acceptInvitation',
        description: "The signed-in user's verified email must be the invited one (case-insensitive). Single use.",
        parameters: [token],
        responses: { 200: json(ref('InvitationAccepted')), 403: error('Other email, or not verified'), 404: error('Unknown link'), 410: error('Used, revoked or expired') },
      },
    },
    '/api/w/{workspace}': {
      get: { tags: ['Workspaces'], summary: 'The workspace and your role', operationId: 'getWorkspace', parameters: [ws], responses: { 200: json(ref('Workspace')), ...notFound } },
      patch: {
        tags: ['Workspaces'], summary: 'Rename or change the slug (owner)', operationId: 'updateWorkspace', parameters: [ws],
        requestBody: body('WorkspaceUpdate'), responses: { 200: json(ref('Workspace')), ...bad, ...owner, ...notFound, 409: error('Slug taken') },
      },
      delete: {
        tags: ['Workspaces'], summary: 'Delete the workspace (owner)', operationId: 'deleteWorkspace',
        parameters: [ws, query('confirm', 'Must repeat the slug.')],
        responses: { 200: json(object({ deleted: { type: 'boolean' } })), ...bad, ...owner, ...notFound, 409: error('AWS accounts connected, or the default workspace') },
      },
    },
    '/api/w/{workspace}/members': {
      get: { tags: ['Workspaces'], summary: 'Members', operationId: 'listMembers', parameters: [ws], responses: { 200: json(ref('MemberList')), ...single, ...notFound } },
    },
    '/api/w/{workspace}/members/{sub}': {
      patch: {
        tags: ['Workspaces'], summary: "Change a member's role (owner)", operationId: 'updateMember', parameters: [ws, sub],
        requestBody: body('MemberUpdate'), responses: { 200: json(ref('Member')), ...owner, ...notFound, 409: error('Last owner') },
      },
      delete: {
        tags: ['Workspaces'], summary: 'Remove a member (owner), or leave', operationId: 'removeMember', parameters: [ws, sub],
        responses: { 200: json(object({ removed: { type: 'boolean' } })), ...owner, ...notFound, 409: error('Last owner') },
      },
    },
    '/api/w/{workspace}/invitations': {
      get: {
        tags: ['Workspaces'], summary: 'Invitations (owner)', operationId: 'listInvitations',
        parameters: [ws, query('all', '1 includes accepted, revoked and expired ones.')], responses: { 200: json(ref('InvitationList')), ...owner, ...notFound },
      },
      post: {
        tags: ['Workspaces'], summary: 'Invite by email (owner)', operationId: 'createInvitation', parameters: [ws],
        requestBody: body('InvitationCreate'), responses: { 201: json(ref('InvitationCreated'), 'Created'), ...bad, ...owner, ...notFound, 409: error('Already a member') },
      },
    },
    '/api/w/{workspace}/invitations/{id}': {
      delete: {
        tags: ['Workspaces'], summary: 'Revoke an invitation (owner)', operationId: 'revokeInvitation',
        parameters: [ws, path('id', 'Invitation ID.')], responses: { 200: json(ref('Invitation')), ...owner, ...notFound, 409: error('Not pending') },
      },
    },
    '/api/w/{workspace}/usage': {
      get: {
        tags: ['Workspaces'], summary: "This month's traces and the workspace's limits", operationId: 'getUsage',
        description: 'Traces (Lambda invocations) of all the workspace\'s projects, per calendar month (UTC). See limits.md.',
        parameters: [ws], responses: { 200: json(ref('Usage')), ...notFound },
      },
    },
    '/api/w/{workspace}/projects': {
      get: {
        tags: ['Projects'], summary: 'Projects', operationId: 'listProjects',
        parameters: [ws, query('archived', '1 includes archived projects.')], responses: { 200: json(ref('ProjectList')), ...notFound },
      },
      post: {
        tags: ['Projects'], summary: 'Create a project', operationId: 'createProject', parameters: [ws],
        description: 'The slug is generated from the name (-2, -3, … on collisions within the workspace).',
        requestBody: body('ProjectCreate'), responses: { 201: json(ref('Project'), 'Created'), ...bad, ...notFound, 409: error('Slug taken') },
      },
    },
    '/api/w/{workspace}/p/{project}': {
      get: { tags: ['Projects'], summary: 'One project', operationId: 'getProject', parameters: [ws, prj], responses: { 200: json(ref('Project')), ...notFound } },
      patch: {
        tags: ['Projects'], summary: 'Rename, change the slug, archive or unarchive', operationId: 'updateProject', parameters: [ws, prj],
        requestBody: body('ProjectUpdate'), responses: { 200: json(ref('Project')), ...bad, ...notFound, 409: error('Slug taken, or archiving the default project') },
      },
    },
    '/api/w/{workspace}/p/{project}/keys': {
      get: {
        tags: ['Projects'], summary: 'Ingest keys of the project', operationId: 'listKeys',
        parameters: [ws, prj, query('revoked', '1 includes revoked keys.')], responses: { 200: json(ref('KeyList')), ...notFound },
      },
      post: {
        tags: ['Projects'], summary: 'Create an ingest key (shown once)', operationId: 'createKey', parameters: [ws, prj],
        requestBody: body('KeyCreate'), responses: { 201: json(ref('KeyCreated'), 'Created'), ...notFound, 409: error('Project archived') },
      },
    },
    '/api/w/{workspace}/p/{project}/keys/{id}': {
      delete: {
        tags: ['Projects'], summary: 'Revoke an ingest key', operationId: 'revokeKey',
        parameters: [ws, prj, path('id', 'Key ID.')], responses: { 200: json(ref('Key')), ...notFound, 409: error('The IVY_INGEST_API_KEY key') },
      },
    },
    '/api/w/{workspace}/p/{project}/functions': {
      get: { tags: ['Traces'], summary: 'Function overview for the range', operationId: 'listFunctions', parameters: [ws, prj, ...range], responses: { 200: json(ref('FunctionList')), ...bad, ...notFound } },
    },
    '/api/w/{workspace}/functions': {
      get: {
        tags: ['Traces'], summary: 'Function overview of every project of the workspace', operationId: 'listWorkspaceFunctions',
        parameters: [ws, ...range], responses: { 200: json(ref('FunctionList')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/p/{project}/invocations': {
      get: {
        tags: ['Traces'], summary: 'Invocations, newest first', operationId: 'listInvocations',
        parameters: [
          ws, prj, ...range, fn,
          query('status', 'Only ok or error.', { type: 'string', enum: ['ok', 'error'] }),
          query('q', 'Free text: request ID or trace ID (exact), or text in the error message or HTTP path.'),
          query('limit', 'Page size.', { type: 'integer', minimum: 1, maximum: 500, default: 50 }),
          query('cursor', 'Opaque cursor from next_cursor.'),
        ],
        responses: { 200: json(ref('InvocationList')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/p/{project}/traces/{traceId}': {
      get: {
        tags: ['Traces'], summary: 'All spans of a trace', operationId: 'getTrace',
        description: 'Spans sorted by start time. With `format=text`, a compact text tree for LLMs (see mcp.md and the @ivy/format package).',
        parameters: [
          ws, prj,
          path('traceId', '32 hex characters.'),
          query('format', '`json` (default) or `text`.', { type: 'string', enum: ['json', 'text'], default: 'json' }),
          query('detail', 'Text format only: summary, normal or full.', { type: 'string', enum: ['summary', 'normal', 'full'], default: 'normal' }),
          query('max_tokens', 'Text format only: approximate size budget; 0 for no limit.', { type: 'integer', minimum: 0, default: 4000 }),
        ],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: ref('Trace') }, 'text/plain': { schema: { type: 'string' } } } },
          404: error('Trace (or workspace, project) not found'),
        },
      },
    },
    '/api/w/{workspace}/p/{project}/errors': {
      get: {
        tags: ['Traces'], summary: 'Error groups (function + error type + normalized message), plus one `Throttled` group per throttled function', operationId: 'listErrorGroups',
        parameters: [ws, prj, ...range, fn], responses: { 200: json(ref('ErrorGroupList')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/errors': {
      get: {
        tags: ['Traces'], summary: 'Error groups of every project of the workspace', operationId: 'listWorkspaceErrorGroups',
        parameters: [ws, ...range, fn], responses: { 200: json(ref('ErrorGroupList')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/p/{project}/stats/timeseries': {
      get: {
        tags: ['Traces'], summary: 'Invocations, errors, p95 and throttles per bucket', operationId: 'getTimeseries',
        parameters: [
          ws, prj, ...range, fn,
          query('bucket', 'Bucket size; default keeps about 100 points or fewer.', { type: 'string', enum: ['1m', '5m', '15m', '1h', '1d'] }),
        ],
        responses: { 200: json(ref('Timeseries')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/aws/setup': {
      get: { tags: ['Auto-trace'], summary: 'Server-side configuration for the connect flow', operationId: 'getAwsSetup', parameters: [ws], responses: { 200: json(ref('AwsSetup')), ...notFound } },
    },
    '/api/w/{workspace}/aws/template.yaml': {
      get: {
        tags: ['Auto-trace'], summary: "A connection's CloudFormation template (contains its event secret)", operationId: 'getAwsTemplate',
        parameters: [
          ws,
          query('account', "Connection ID: that connection's values as parameter defaults."),
          query('download', '1 adds content-disposition: attachment.'),
        ],
        responses: { 200: { description: 'Template', content: { 'text/yaml': { schema: { type: 'string' } } } }, ...notFound },
      },
    },
    '/api/me/notifications': {
      get: {
        tags: ['Alerts'], summary: 'Your digest subscription per workspace', operationId: 'getNotifications',
        responses: { 200: json(ref('Notifications')), 403: error('Auth is off') },
      },
      put: {
        tags: ['Alerts'], summary: 'Subscribe to or unsubscribe from a workspace\'s digest', operationId: 'updateNotifications',
        requestBody: body('NotificationUpdate'),
        responses: { 200: json(ref('NotificationItem')), ...bad, 403: error('Auth is off'), ...notFound },
      },
    },
    '/api/w/{workspace}/p/{project}/alerts': {
      get: {
        tags: ['Alerts'], summary: 'Alert settings and Slack channels of the project', operationId: 'getAlerts',
        parameters: [ws, prj], responses: { 200: json(ref('Alerts')), ...notFound },
      },
      put: {
        tags: ['Alerts'], summary: 'Change the alert settings (owner)', operationId: 'updateAlerts',
        description: 'Partial update. A message is sent when a group is first seen, then at most every `interval_minutes` or every `every_occurrences` occurrences, whichever comes first.',
        parameters: [ws, prj], requestBody: body('AlertSettingsUpdate'), responses: { 200: json(ref('AlertSettings')), ...bad, ...owner, ...notFound },
      },
    },
    '/api/w/{workspace}/p/{project}/alerts/slack/connect': {
      post: {
        tags: ['Alerts'], summary: 'Start "Add to Slack" (owner)', operationId: 'connectSlack',
        description: 'Returns Slack\'s OAuth v2 authorize URL (scope `incoming-webhook`) with a signed state valid for 10 minutes, and sets a cookie that the callback checks.',
        parameters: [ws, prj], responses: { 200: json(object({ url: { type: 'string' } })), ...owner, ...notFound, 409: error('Slack is not configured') },
      },
    },
    '/api/w/{workspace}/p/{project}/alerts/slack/{id}': {
      delete: {
        tags: ['Alerts'], summary: 'Remove a Slack channel (owner)', operationId: 'removeSlackChannel',
        parameters: [ws, prj, path('id', 'Channel ID (slk_…).')], responses: { 200: json(object({ removed: { type: 'boolean' } })), ...owner, ...notFound },
      },
    },
    '/api/w/{workspace}/p/{project}/alerts/slack/{id}/test': {
      post: {
        tags: ['Alerts'], summary: 'Send a test message (owner)', operationId: 'testSlackChannel',
        parameters: [ws, prj, path('id', 'Channel ID (slk_…).')],
        responses: { 200: json(ref('SlackTestResult')), ...owner, ...notFound, 409: error('Slack is not configured') },
      },
    },
    '/api/slack/oauth/callback': {
      get: {
        tags: ['Alerts'], summary: 'Slack OAuth redirect', operationId: 'slackOAuthCallback', security: PUBLIC,
        description: 'Checks the signed state and the cookie from connect, exchanges the code (oauth.v2.access), stores the webhook encrypted and redirects to the project\'s alert settings with `?slack=connected|denied|error`.',
        parameters: [query('code', 'From Slack.'), query('state', 'From connect.'), query('error', 'From Slack when the user cancelled.')],
        responses: { 302: { description: 'Back to the alert settings' }, 400: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } }, 409: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } },
      },
    },
    '/api/w/{workspace}/digest': {
      get: { tags: ['Alerts'], summary: 'The weekly email digest of the workspace', operationId: 'getDigest', parameters: [ws], responses: { 200: json(ref('Digest')), ...notFound } },
      put: {
        tags: ['Alerts'], summary: 'Switch the digest on or off (owner)', operationId: 'updateDigest', parameters: [ws],
        requestBody: body('DigestUpdate'), responses: { 200: json(ref('DigestUpdate')), ...bad, ...owner, ...notFound },
      },
    },
    '/api/w/{workspace}/digest/preview': {
      get: {
        tags: ['Alerts'], summary: 'Preview the digest (the last seven days)', operationId: 'previewDigest',
        parameters: [ws], responses: { 200: json(ref('DigestPreview')), ...notFound },
      },
    },
    '/api/digest/unsubscribe': {
      get: {
        tags: ['Alerts'], summary: 'Unsubscribe page (link in the digest)', operationId: 'getUnsubscribe', security: PUBLIC,
        parameters: [query('token', 'Signed token from the email.')], responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } }, 400: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } },
      },
      post: {
        tags: ['Alerts'], summary: 'Unsubscribe (also RFC 8058 one-click)', operationId: 'unsubscribe', security: PUBLIC,
        parameters: [query('token', 'Signed token from the email.')], responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } }, 400: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } },
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
    '/api/w/{workspace}/aws/accounts': {
      get: { tags: ['Auto-trace'], summary: 'Connected AWS accounts', operationId: 'listAwsAccounts', parameters: [ws], responses: { 200: json(ref('AwsAccountList')), ...notFound } },
      post: {
        tags: ['Auto-trace'], summary: 'Start connecting an AWS account (traces nothing yet)', operationId: 'createAwsAccount', parameters: [ws],
        requestBody: body('AwsAccountCreate'),
        responses: { 201: json(ref('AwsAccount'), 'Created (status pending)'), ...bad, ...notFound, 409: error('Account already connected') },
      },
    },
    '/api/w/{workspace}/aws/accounts/{id}': {
      get: { tags: ['Auto-trace'], summary: 'One connection', operationId: 'getAwsAccount', parameters: [ws, accountId], responses: { 200: json(ref('AwsAccount')), ...notFound } },
      patch: {
        tags: ['Auto-trace'], summary: 'Update a connection', operationId: 'updateAwsAccount',
        parameters: [ws, accountId], requestBody: body('AwsAccountUpdate'), responses: { 200: json(ref('AwsAccount')), ...bad, ...notFound },
      },
      delete: {
        tags: ['Auto-trace'], summary: 'Remove a connection', operationId: 'deleteAwsAccount',
        description: 'Removes the layer from all functions first unless detach=false (or the account is pending).',
        parameters: [ws, accountId, query('detach', 'Detach the layer first (default true).', { type: 'string', enum: ['true', 'false'] })],
        responses: { 200: json(ref('AwsDeleteResult')), ...notFound },
      },
    },
    '/api/w/{workspace}/aws/accounts/{id}/verify': {
      post: {
        tags: ['Auto-trace'], summary: 'Try AssumeRole; on success the account becomes connected', operationId: 'verifyAwsAccount',
        parameters: [ws, accountId], responses: { 200: json(ref('AwsVerifyResult')), ...notFound },
      },
    },
    '/api/w/{workspace}/aws/accounts/{id}/sync': {
      post: {
        tags: ['Auto-trace'], summary: 'Sync the functions of a connection', operationId: 'syncAwsAccount',
        parameters: [ws, accountId, query('wait', '1 waits for the sync to finish.')],
        responses: { 202: json(object({ started: { type: 'boolean' } }), 'Started'), ...notFound, 409: error('Account pending') },
      },
    },
    '/api/w/{workspace}/aws/accounts/{id}/functions': {
      get: {
        tags: ['Auto-trace'], summary: "A connection's functions grouped by CloudFormation stack", operationId: 'listAwsAccountFunctions',
        parameters: [ws, accountId], responses: { 200: json(ref('AwsFunctionGroups')), ...notFound },
      },
    },
    '/api/w/{workspace}/aws/functions': {
      get: {
        tags: ['Auto-trace'], summary: 'Every known function of the workspace', operationId: 'listAwsFunctions',
        parameters: [ws, query('account', '12-digit AWS account ID.'), query('project', 'Slug or ID: functions sending to it.'), query('state', 'Tracing state.')],
        responses: { 200: json(ref('AwsFunctionList')), ...notFound },
      },
    },
    '/api/w/{workspace}/aws/functions/bulk': {
      post: {
        tags: ['Auto-trace'], summary: 'The same manual choice for many functions', operationId: 'bulkUpdateAwsFunctions', parameters: [ws],
        requestBody: body('AwsFunctionBulk'), responses: { 202: json(object({ updated: { type: 'integer' } }), 'Stored; applied by a sync'), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/aws/functions/{accountId}/{region}/{name}': {
      put: {
        tags: ['Auto-trace'], summary: 'Manual choice for one function: trace into a project, exclude, or follow the rules', operationId: 'updateAwsFunction',
        description: 'Stores the choice, then applies it right away. If applying fails the choice is kept and the next sync retries.',
        parameters: [ws, path('accountId', '12-digit AWS account ID.'), path('region', 'AWS region.'), path('name', 'Function name.')],
        requestBody: body('AwsFunctionChoice'),
        responses: { 200: json(ref('AwsFunctionUpdateResult')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/aws/rules': {
      get: { tags: ['Auto-trace'], summary: 'Auto-trace rules, in evaluation order', operationId: 'listRules', parameters: [ws], responses: { 200: json(ref('RuleList')), ...notFound } },
      post: {
        tags: ['Auto-trace'], summary: 'Create a rule (optionally with a new project); re-syncs', operationId: 'createRule', parameters: [ws],
        requestBody: body('RuleCreate'), responses: { 201: json(ref('RuleCreated'), 'Created'), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/aws/rules/dry-run': {
      post: {
        tags: ['Auto-trace'], summary: 'Which functions a matcher selects, and what a rule with it would change', operationId: 'dryRunRule', parameters: [ws],
        requestBody: body('RuleDryRun'), responses: { 200: json(ref('RuleDryRunResult')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/aws/rules/order': {
      put: {
        tags: ['Auto-trace'], summary: 'Reorder rules; re-syncs', operationId: 'reorderRules', parameters: [ws],
        requestBody: body('RuleOrder'), responses: { 200: json(ref('RuleList')), ...bad, ...notFound },
      },
    },
    '/api/w/{workspace}/aws/rules/{id}': {
      patch: {
        tags: ['Auto-trace'], summary: 'Update a rule; re-syncs', operationId: 'updateRule', parameters: [ws, path('id', 'Rule ID.')],
        requestBody: body('RuleUpdate'), responses: { 200: json(ref('Rule')), ...bad, ...notFound },
      },
      delete: {
        tags: ['Auto-trace'], summary: 'Delete a rule; re-syncs (functions only it selected are detached)', operationId: 'deleteRule',
        parameters: [ws, path('id', 'Rule ID.')], responses: { 200: json(object({ deleted: { type: 'boolean' } })), ...notFound },
      },
    },
  },
};
