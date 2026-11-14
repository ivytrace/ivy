/** Component schemas of the OpenAPI document (shapes from docs/implementation/api.md). */

const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const num = { type: 'number' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const time = { type: 'string', format: 'date-time' } as const;
const ntime = { type: ['string', 'null'], format: 'date-time' } as const;
const strMap = { type: 'object', additionalProperties: { type: 'string' } } as const;

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});

const list = (ref: string) => object({ items: { type: 'array', items: { $ref: `#/components/schemas/${ref}` } } });

export const schemas = {
  Error: object({ error: str }),
  Health: object({ ok: bool, clickhouse: bool }),
  Config: object({ version: str, auth: object({ enabled: bool }) }),
  FunctionSummary: object({
    name: str, region: str, invocations: int, errors: int, error_rate: num, cold_starts: int,
    avg_ms: num, p50_ms: num, p95_ms: num, p99_ms: num, last_invoked: ntime,
    throttles: { type: 'integer', description: 'Invocations Lambda rejected (CloudWatch `Throttles`); they never reached the function. 0 when throttle polling is off.' },
  }),
  FunctionList: list('FunctionSummary'),
  Invocation: object({
    trace_id: str, span_id: str, ts: time, function: str, region: str,
    status: { type: 'string', enum: ['ok', 'error'] }, duration_ms: num, cold_start: bool, request_id: str,
    trigger: { type: 'string', examples: ['aws:apigatewayv2', 'aws:sqs'] },
    http_method: nstr, http_path: nstr, http_status: { type: ['integer', 'null'] },
    error_type: nstr, error_message: nstr, memory_used_mb: { type: ['number', 'null'] },
  }),
  InvocationList: object({
    items: { type: 'array', items: { $ref: '#/components/schemas/Invocation' } },
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
    attributes: { ...strMap, description: 'Span attributes as stored (strings); JSON-valued ones (`ivy.payload.*`, headers, arrays) are JSON strings. See span-conventions.md.' },
    resource: strMap,
    events: { type: 'array', items: { $ref: '#/components/schemas/SpanEvent' } },
  }),
  Trace: object({ trace_id: str, spans: { type: 'array', items: { $ref: '#/components/schemas/Span' } } }),
  ErrorGroup: object({
    fingerprint: str, function: str, error_type: str, error_message: str, count: int,
    first_seen: time, last_seen: time,
    sample_trace_id: { ...nstr, description: 'null for the synthetic `Throttled` group: throttled requests never reach the function, so there is no trace.' },
    kind: { type: 'string', enum: ['error', 'throttle'], description: '`throttle`: one synthetic group per function counting throttles (error_type `Throttled`).' },
  }),
  ErrorGroupList: list('ErrorGroup'),
  TimeseriesPoint: object({ ts: time, invocations: int, errors: int, p95_ms: num, throttles: int }),
  Timeseries: list('TimeseriesPoint'),
  AwsSetup: object({
    principal_arn: nstr, template_url: nstr, events_url: nstr, public_url: nstr, ingest_endpoint: nstr, layer_sha256: nstr,
    default_region: str, regions: { type: 'array', items: str }, sync_interval_seconds: int,
    issues: { type: 'array', items: str },
  }),
  AwsAccount: object({
    id: str, name: str, account_id: str, role_arn: str, external_id: str, stack_name: str, stack_region: str,
    regions: { type: 'array', items: str }, all_regions: bool,
    status: { type: 'string', enum: ['pending', 'connected', 'error'] },
    error: { ...nstr, description: 'On a connected account: per-region sync errors, one per line.' },
    created_at: time, verified_at: ntime, last_sync_at: ntime, syncing: bool,
    throttle_metrics: { type: 'boolean', description: 'Poll CloudWatch for Lambda throttles (GetMetricData, billed to this AWS account).' },
    throttle_status: {
      type: ['string', 'null'], enum: ['ok', 'missing_permission', 'error', null],
      description: '`missing_permission`: the stack predates `cloudwatch:GetMetricData`; update the stack with the current template.',
    },
    counts: object({ traced: int, opted_out: int, unsupported: int, conflict: int, error: int, pending: int, total: int }),
    quick_create_url: nstr, template_download_url: str,
  }),
  AwsAccountList: list('AwsAccount'),
  AwsAccountCreate: object(
    {
      account_id: { type: 'string', pattern: '^\\d{12}$' },
      name: str,
      regions: { type: 'array', items: str },
      all_regions: bool,
      stack_region: str,
      throttle_metrics: { type: 'boolean', default: true },
    },
    ['account_id', 'regions'],
  ),
  AwsAccountUpdate: object({ name: str, regions: { type: 'array', items: str }, all_regions: bool, throttle_metrics: bool }, []),
  AwsVerifyResult: object({ verified: bool, account: { $ref: '#/components/schemas/AwsAccount' } }),
  AwsDeleteResult: object({ deleted: bool, detached: bool, detach_errors: { type: 'array', items: str } }),
  AwsFunction: object({
    account_id: str, region: str, name: str, arn: str, runtime: str,
    state: { type: 'string', enum: ['traced', 'opted_out', 'unsupported', 'conflict', 'error', 'pending'] },
    reason: nstr,
    tracing_enabled: { type: 'boolean', description: 'The dashboard setting; a function opted out by its `ivy:trace=false` tag has state `opted_out` and tracing_enabled true.' },
    updated_at: time,
  }),
  AwsFunctionList: list('AwsFunction'),
  AwsFunctionUpdate: object({ tracing_enabled: bool }),
  AwsFunctionUpdateResult: object({
    applied: bool, error: nstr,
    function: { oneOf: [{ $ref: '#/components/schemas/AwsFunction' }, { type: 'null' }] },
  }),
};
