/** Component schemas of the OpenAPI document (shapes from docs/implementation/api.md). */

const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const num = { type: 'number' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const time = { type: 'string', format: 'date-time' } as const;
const ntime = { type: ['string', 'null'], format: 'date-time' } as const;
const strMap = { type: 'object', additionalProperties: { type: 'string' } } as const;
const strs = { type: 'array', items: str } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const role = { type: 'string', enum: ['owner', 'member'] } as const;

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});

const failureKind = {
  type: ['string', 'null'],
  enum: ['init_failed', 'out_of_memory', 'timed_out', 'crashed', null],
  description:
    'Failure outside the handler, reported by the Ivy extension from the Lambda Telemetry API (labels: Init failed, ' +
    'Out of memory, Timed out, Crashed). Null for successful invocations and ordinary handler errors.',
} as const;


const list = (name: string) => object({ items: { type: 'array', items: ref(name) } });
const projectFields = {
  project_id: { type: 'string', description: 'Workspace-wide routes only.' },
  project: { ...nstr, description: 'Project slug; workspace-wide routes only.' },
};

const TRACE_STATES = ['traced', 'available', 'opted_out', 'unsupported', 'conflict', 'error', 'pending'];

const matcher = object(
  {
    account_id: { ...nstr, description: '12-digit AWS account ID, exact.' },
    region: { ...nstr, description: 'AWS region, exact.' },
    stack: { ...nstr, description: 'Glob on the CloudFormation stack name (`aws:cloudformation:stack-name` tag).' },
    name: { ...nstr, description: 'Glob on the function name; `orders-*` is a prefix match, `*` matches every function.' },
    tag: { ...nstr, description: '`key=value` (value may be a glob) or `key`.' },
  },
  [],
);

export const schemas = {
  Error: object({ error: str }),
  Health: object({ ok: bool, clickhouse: bool }),
  Config: object({
    version: str,
    auth: object({ enabled: bool }, ['enabled']),
    workspaces: object({ multi: { type: 'boolean', description: 'False: one workspace (`default`), no members or invitations.' } }),
    email: object({ enabled: { type: 'boolean', description: 'Invitations are also emailed.' } }),
    aws: object({ quick_create: { type: 'boolean', description: 'The publish-cfn-template hook is installed (one-click CloudFormation links).' } }),
    billing: object({ url: { type: 'string', description: 'Billing service for Upgrade / Manage billing (IVY_BILLING_URL); absent without one.' } }),
  }, ['version', 'auth', 'workspaces', 'email', 'aws']),

  Limits: object({
    plan: { type: 'string', description: 'Plan label; empty when none.' },
    monthly_trace_quota: { type: ['integer', 'null'], description: 'Traces per calendar month (UTC); null is unlimited.' },
    over_quota: { type: 'string', enum: ['block', 'allow'], description: '`block` rejects ingest at the quota; `allow` keeps accepting.' },
    source: { type: 'string', enum: ['workspace', 'unset'], description: '`unset`: the workspace has no limits and is unlimited.' },
  }),
  Usage: object({
    workspace: str,
    month: { type: 'string', examples: ['2026-11'] },
    period: object({ start: time, end: time }),
    traces: { type: 'integer', description: 'Traces (Lambda invocations) this month, across all projects of the workspace.' },
    limits: { $ref: '#/components/schemas/Limits' },
    blocked: { type: 'boolean', description: 'Ingest is being refused: quota reached with over_quota `block`.' },
  }),
  Workspace: object({
    id: str, slug: str, name: str, role, default: bool,
    default_project_id: { type: 'string', description: 'The default project: keys without a project and functions traced without a project go there.' },
    created_at: time,
  }),
  WorkspaceList: list('Workspace'),
  WorkspaceCreate: object({ name: str, slug: { type: 'string', description: 'Optional; generated from the name when omitted.' } }, ['name']),
  WorkspaceUpdate: object({
    name: str, slug: str,
    default_project: { type: 'string', description: 'Slug or ID of an active project to make the default (any member may change it; name and slug are for owners).' },
  }, []),
  Member: object({ sub: str, email: nstr, role, you: bool, joined_at: time }),
  MemberList: list('Member'),
  MemberUpdate: object({ role }),
  Invitation: object({
    id: str, email: str, role,
    status: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] },
    invited_by: nstr, created_at: time, expires_at: time, accepted_at: ntime,
  }),
  InvitationList: list('Invitation'),
  InvitationCreate: object({ email: str, role }, ['email']),
  InvitationCreated: object({
    invitation: ref('Invitation'),
    url: { type: 'string', description: 'The invite link with its token; returned only here.' },
    email_sent: bool, email_error: nstr,
  }),
  InvitationInfo: object({
    workspace: object({ slug: str, name: str }), email: str, role,
    status: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] }, invited_by: nstr, expires_at: time,
  }),
  InvitationAccepted: object({ accepted: bool, workspace: ref('Workspace') }),
  Project: object({ id: str, slug: str, name: str, archived: bool, default: bool, created_at: time }),
  ProjectList: list('Project'),
  ProjectCreate: object({ name: str, slug: { type: 'string', description: 'Optional; generated from the name when omitted.' } }, ['name']),
  ProjectUpdate: object({
    name: str, slug: str, archived: bool,
    new_default: { type: 'string', description: 'With `archived: true` on the default project: slug or ID of the project that becomes the default (default: the oldest remaining active project). Ignored for other projects.' },
  }, []),
  Key: object({
    id: str, name: str, kind: { type: 'string', enum: ['user', 'auto-trace', 'bootstrap'] },
    prefix: str, created_at: time, revoked_at: ntime,
  }),
  KeyList: list('Key'),
  KeyCreate: object({ name: str }, []),
  KeyCreated: object({
    id: str, name: str, kind: str, prefix: str, created_at: time, revoked_at: ntime,
    key: { type: 'string', description: 'The ingest key; returned only here.' },
    endpoint: nstr,
  }),

  FunctionSummary: object(
    {
      name: str, region: str, ...projectFields, invocations: int, errors: int, error_rate: num, cold_starts: int,
      avg_ms: num, p50_ms: num, p95_ms: num, p99_ms: num, last_invoked: { ...ntime, description: 'null for a function that was only throttled in the range.' },
      throttles: { type: 'integer', description: 'Invocations Lambda rejected (CloudWatch `Throttles`); they never reached the function. 0 when throttle polling is off.' },
    },
    ['name', 'region', 'invocations', 'errors', 'error_rate', 'cold_starts', 'avg_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'last_invoked'],
  ),
  FunctionList: list('FunctionSummary'),
  Invocation: object({
    trace_id: str, span_id: str, ...projectFields, ts: time, function: str, region: str,
    status: { type: 'string', enum: ['ok', 'error'] }, duration_ms: num, cold_start: bool, request_id: str,
    trigger: { type: 'string', examples: ['aws:apigatewayv2', 'aws:sqs'] },
    http_method: nstr, http_path: nstr, http_status: { type: ['integer', 'null'] },
    error_type: nstr, error_message: nstr, memory_used_mb: { type: ['number', 'null'] },
    memory_limit_mb: { type: ['integer', 'null'] },
    failure_phase: { type: ['string', 'null'], enum: ['init', 'invoke', null] },
    failure_kind: failureKind,
    synthetic: {
      type: 'boolean',
      description: 'The extension created the invocation span itself because the tracer reported nothing (init failure, crash): the trace has no child spans.',
    },
    init_duration_ms: { type: ['number', 'null'], description: 'Set on cold starts.' },
  }),
  InvocationList: object({
    items: { type: 'array', items: ref('Invocation') },
    next_cursor: { ...nstr, description: 'Pass as `cursor` for the next page; null on the last page.' },
  }),
  SpanEvent: object({ ts: time, name: str, attributes: strMap }),
  Span: object({
    span_id: str,
    parent_span_id: { type: 'string', description: 'Empty for root spans.' },
    name: str,
    kind: { type: 'string', examples: ['SERVER', 'CLIENT', 'CONSUMER', 'PRODUCER', 'INTERNAL'] },
    service: str, start: time, end: time, duration_ms: num,
    status_code: { type: 'string', enum: ['OK', 'ERROR', 'UNSET'] },
    status_message: str,
    attributes: {
      ...strMap,
      description:
        'Span attributes as stored (strings); JSON-valued ones (`ivy.payload.*`, headers, arrays) are JSON strings. See ' +
        'span-conventions.md. Late Lambda report data (`ivy.billed_duration_ms`, `ivy.memory_max_used_mb`, ' +
        '`ivy.memory_size_mb`) is merged into the invocation span; update spans are never listed themselves.',
    },
    resource: strMap,
    events: { type: 'array', items: ref('SpanEvent') },
  }),
  Trace: object({ trace_id: str, spans: { type: 'array', items: ref('Span') } }),
  ErrorGroup: object(
    {
      fingerprint: str, function: str, ...projectFields, error_type: str, error_message: str, count: int,
      first_seen: time, last_seen: time,
      sample_trace_id: { ...nstr, description: 'null for the synthetic `Throttled` group: throttled requests never reach the function, so there is no trace.' },
      kind: { type: 'string', enum: ['error', 'throttle'], description: '`throttle`: one synthetic group per function counting throttles (error_type `Throttled`).' },
      failure_kind: failureKind,
    },
    ['fingerprint', 'function', 'error_type', 'error_message', 'count', 'first_seen', 'last_seen', 'sample_trace_id'],
  ),
  ErrorGroupList: list('ErrorGroup'),
  TimeseriesPoint: object({ ts: time, invocations: int, errors: int, p95_ms: num, throttles: int }),
  Timeseries: list('TimeseriesPoint'),

  AwsSetup: object({
    principal_arn: nstr, quick_create: bool, events_url: nstr, public_url: nstr, ingest_endpoint: nstr, layer_sha256: nstr,
    default_region: str, regions: strs, sync_interval_seconds: int, issues: strs,
  }),
  AwsAccount: object({
    id: str, name: str, account_id: str, role_arn: str, external_id: str, stack_name: str, stack_region: str,
    default_project_id: nstr, default_project: nstr,
    regions: strs, all_regions: bool,
    status: { type: 'string', enum: ['pending', 'connected', 'error'] },
    error: { ...nstr, description: 'On a connected account: per-region sync errors, one per line.' },
    created_at: time, verified_at: ntime, last_sync_at: ntime, reviewed_at: ntime, syncing: bool,
    throttle_metrics: { type: 'boolean', description: 'Poll CloudWatch for Lambda throttles (GetMetricData, billed to this AWS account).' },
    throttle_status: {
      type: ['string', 'null'], enum: ['ok', 'missing_permission', 'error', null],
      description: '`missing_permission`: the stack predates `cloudwatch:GetMetricData`; update the stack with the current template.',
    },
    counts: object({ ...Object.fromEntries(TRACE_STATES.map((s) => [s, int])), total: int, new: int }),
    quick_create_url: { ...nstr, description: 'Only with the publish-cfn-template hook; carries no parameters or secrets.' },
    quick_create_error: { ...nstr, description: 'Why there is no quick-create link although the hook exists.' },
    template_download_url: str,
  }),
  AwsAccountList: list('AwsAccount'),
  AwsAccountCreate: object(
    {
      account_id: { type: 'string', pattern: '^\\d{12}$' },
      name: str,
      regions: strs,
      all_regions: bool,
      stack_region: str,
      default_project: { type: 'string', description: 'Project the UI preselects (slug or ID); never causes tracing by itself.' },
      throttle_metrics: { type: 'boolean', default: true },
    },
    ['account_id', 'regions'],
  ),
  AwsAccountUpdate: object(
    { name: str, regions: strs, all_regions: bool, default_project: nstr, throttle_metrics: bool, reviewed: { type: 'boolean', description: '`true` marks the function list as seen.' } },
    [],
  ),
  AwsVerifyResult: object({ verified: bool, account: ref('AwsAccount') }),
  AwsDeleteResult: object({ deleted: bool, detached: bool, detach_errors: strs }),
  AwsFunction: object({
    account_id: str, region: str, name: str, arn: str, runtime: str,
    stack: nstr, tags: strMap, last_modified: nstr,
    state: { type: 'string', enum: TRACE_STATES },
    reason: nstr,
    project_id: nstr, project: nstr,
    source: { type: ['string', 'null'], enum: ['tag', 'manual', 'rule', null], description: 'What decided the tracing state.' },
    rule_id: nstr,
    manual: {
      oneOf: [object({ mode: { type: 'string', enum: ['trace', 'exclude'] }, project_id: nstr, project: nstr }), { type: 'null' }],
    },
    new: bool, first_seen_at: ntime, updated_at: time,
  }),
  AwsFunctionList: list('AwsFunction'),
  AwsFunctionGroups: object({
    groups: {
      type: 'array',
      items: object({
        stack: nstr, region: nstr,
        counts: object({ total: int, traced: int, available: int, new: int }),
        rule: { oneOf: [object({ id: str, project_id: str, project: nstr, enabled: bool }), { type: 'null' }] },
        suggested_project: nstr,
        functions: { type: 'array', items: ref('AwsFunction') },
      }),
    },
  }),
  AwsFunctionChoice: object(
    { mode: { type: 'string', enum: ['trace', 'exclude', 'rules'] }, project: { type: 'string', description: 'With mode `trace`; default: the default project.' } },
    ['mode'],
  ),
  AwsFunctionUpdateResult: object({ applied: bool, error: nstr, function: { oneOf: [ref('AwsFunction'), { type: 'null' }] } }),
  AwsFunctionBulk: object(
    {
      functions: { type: 'array', maxItems: 500, items: object({ account_id: str, region: str, name: str }) },
      mode: { type: 'string', enum: ['trace', 'exclude', 'rules'] },
      project: str,
    },
    ['functions', 'mode'],
  ),
  RuleMatcher: matcher,
  Rule: object({ id: str, position: int, matcher: ref('RuleMatcher'), project_id: str, project: nstr, enabled: bool, created_at: time }),
  RuleList: list('Rule'),
  RuleCreate: object(
    {
      matcher: ref('RuleMatcher'),
      project: { type: 'string', description: 'Slug or ID; default: the default project.' },
      new_project: object({ name: str, slug: str }, ['name']),
      enabled: bool,
      position: int,
    },
    ['matcher'],
  ),
  RuleCreated: object({ rule: ref('Rule'), project: ref('Project') }),
  RuleUpdate: object({ matcher: ref('RuleMatcher'), project: str, enabled: bool, position: int }, []),
  RuleOrder: object({ order: strs }),
  RuleDryRun: object({ matcher: ref('RuleMatcher'), project: { type: 'string', description: 'May name a project that does not exist yet.' } }, ['matcher']),
  RuleDryRunResult: object({
    count: int,
    summary: object({ trace: int, unchanged: int, excluded: int, other: int, unsupported: int }),
    items: {
      type: 'array',
      items: object({
        function: ref('AwsFunction'),
        outcome: { type: 'string', enum: ['trace', 'unchanged', 'excluded', 'other', 'unsupported'] },
        project: nstr,
      }),
    },
  }),
};
