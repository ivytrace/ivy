import { SpanKind, type Attributes, type SpanKindValue } from '../tracer/span.js';

export type TriggerSource =
  | 'aws:apigateway'
  | 'aws:apigatewayv2'
  | 'aws:alb'
  | 'aws:function-url'
  | 'aws:sqs'
  | 'aws:sns'
  | 'aws:s3'
  | 'aws:dynamodb'
  | 'aws:eventbridge'
  | 'aws:scheduled'
  | 'aws:kinesis'
  | 'aws:lambda'
  | 'unknown';

export type FaasTrigger = 'http' | 'pubsub' | 'datasource' | 'timer' | 'other';

export interface Trigger {
  source: TriggerSource;
  trigger: FaasTrigger;
  kind: SpanKindValue;
  attributes: Attributes;
}

const lastSegment = (s: unknown, sep: string | RegExp): string | undefined =>
  typeof s === 'string' && s ? s.split(sep).pop() || undefined : undefined;

function make(source: TriggerSource, trigger: FaasTrigger, attributes: Attributes = {}): Trigger {
  const kind =
    trigger === 'http' ? SpanKind.SERVER : trigger === 'pubsub' || trigger === 'datasource' ? SpanKind.CONSUMER : SpanKind.INTERNAL;
  return { source, trigger, kind, attributes };
}

function stripQuery(path: unknown): string | undefined {
  return typeof path === 'string' ? path.split('?')[0] : undefined;
}

function http(source: TriggerSource, method: unknown, path: unknown, route: unknown): Trigger {
  const attributes: Attributes = {};
  if (typeof method === 'string') attributes['http.request.method'] = method.toUpperCase();
  const p = stripQuery(path);
  if (p) attributes['url.path'] = p;
  if (typeof route === 'string' && route) attributes['http.route'] = route;
  return make(source, 'http', attributes);
}

function fromRecords(records: any[]): Trigger {
  const first = records[0] ?? {};
  const source = first.eventSource ?? first.EventSource;
  const count = records.length;
  switch (source) {
    case 'aws:sqs': {
      const attributes: Attributes = { 'messaging.system': 'aws_sqs', 'messaging.batch.message_count': count };
      const queue = lastSegment(first.eventSourceARN, ':');
      if (queue) attributes['messaging.destination.name'] = queue;
      if (count === 1 && first.messageId) attributes['messaging.message.id'] = String(first.messageId);
      return make('aws:sqs', 'pubsub', attributes);
    }
    case 'aws:sns': {
      const attributes: Attributes = { 'messaging.system': 'aws_sns', 'messaging.batch.message_count': count };
      const topic = lastSegment(first.Sns?.TopicArn, ':');
      if (topic) attributes['messaging.destination.name'] = topic;
      if (count === 1 && first.Sns?.MessageId) attributes['messaging.message.id'] = String(first.Sns.MessageId);
      return make('aws:sns', 'pubsub', attributes);
    }
    case 'aws:s3': {
      const attributes: Attributes = {};
      if (first.s3?.bucket?.name) attributes['aws.s3.bucket'] = String(first.s3.bucket.name);
      if (first.s3?.object?.key) attributes['aws.s3.key'] = String(first.s3.object.key);
      if (first.eventName) attributes['ivy.trigger.event_name'] = String(first.eventName);
      return make('aws:s3', 'datasource', attributes);
    }
    case 'aws:dynamodb': {
      const attributes: Attributes = { 'messaging.batch.message_count': count };
      const m = typeof first.eventSourceARN === 'string' ? /:table\/([^/]+)/.exec(first.eventSourceARN) : null;
      if (m) attributes['aws.dynamodb.table_names'] = [m[1]];
      return make('aws:dynamodb', 'datasource', attributes);
    }
    case 'aws:kinesis': {
      const attributes: Attributes = { 'messaging.batch.message_count': count };
      const stream = lastSegment(first.eventSourceARN, '/');
      if (stream && first.eventSourceARN?.includes(':stream/')) attributes['messaging.destination.name'] = stream;
      return make('aws:kinesis', 'pubsub', attributes);
    }
    default:
      return make('unknown', 'other');
  }
}

export function detectTrigger(event: unknown): Trigger {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return make('aws:lambda', 'other');
  const e = event as Record<string, any>;
  const rc = e.requestContext;

  if (Array.isArray(e.Records) && e.Records.length > 0) return fromRecords(e.Records);

  if (rc && typeof rc === 'object') {
    if (rc.elb) return http('aws:alb', e.httpMethod, e.path, undefined);
    if (e.version === '2.0' && rc.http) {
      const isUrl = typeof rc.domainName === 'string' && rc.domainName.includes('.lambda-url.');
      const routeKey = typeof e.routeKey === 'string' && e.routeKey !== '$default' ? e.routeKey : undefined;
      const route = routeKey?.includes(' ') ? routeKey.slice(routeKey.indexOf(' ') + 1) : routeKey;
      return http(isUrl ? 'aws:function-url' : 'aws:apigatewayv2', rc.http.method, e.rawPath ?? rc.http.path, isUrl ? undefined : route);
    }
    if (e.httpMethod) return http('aws:apigateway', e.httpMethod, e.path, e.resource);
  }

  if (typeof e.source === 'string' && typeof e['detail-type'] === 'string') {
    if (e.source === 'aws.events' && e['detail-type'] === 'Scheduled Event') {
      const attributes: Attributes = {};
      const rule = lastSegment(e.resources?.[0], '/');
      if (rule) attributes['ivy.trigger.rule'] = rule;
      return make('aws:scheduled', 'timer', attributes);
    }
    return make('aws:eventbridge', 'pubsub', {
      'aws.eventbridge.source': e.source,
      'aws.eventbridge.detail_types': [e['detail-type']],
    });
  }

  return make('aws:lambda', 'other');
}

/** HTTP status code from a handler result for HTTP triggers. */
export function httpStatusFromResult(source: TriggerSource, result: unknown): number | undefined {
  if (result && typeof result === 'object' && 'statusCode' in result) {
    const code = Number((result as { statusCode: unknown }).statusCode);
    return Number.isInteger(code) ? code : undefined;
  }
  if (source === 'aws:apigatewayv2' || source === 'aws:function-url') return 200;
  return undefined;
}
