import { describe, expect, it } from 'vitest';
import { SpanKind } from '../tracer/span.js';
import { detectTrigger, httpStatusFromResult } from './detect.js';

describe('detectTrigger', () => {
  it('API Gateway REST (v1)', () => {
    const t = detectTrigger({ httpMethod: 'get', path: '/users/1', resource: '/users/{id}', requestContext: { stage: 'prod' } });
    expect(t).toMatchObject({ source: 'aws:apigateway', trigger: 'http', kind: SpanKind.SERVER });
    expect(t.attributes).toEqual({ 'http.request.method': 'GET', 'url.path': '/users/1', 'http.route': '/users/{id}' });
  });

  it('API Gateway HTTP API (v2)', () => {
    const t = detectTrigger({
      version: '2.0',
      routeKey: 'POST /orders/{id}',
      rawPath: '/orders/9',
      requestContext: { domainName: 'x.execute-api.eu-west-1.amazonaws.com', http: { method: 'POST', path: '/orders/9' } },
    });
    expect(t.source).toBe('aws:apigatewayv2');
    expect(t.attributes['http.route']).toBe('/orders/{id}');
  });

  it('API Gateway v2 $default route has no http.route', () => {
    const t = detectTrigger({ version: '2.0', routeKey: '$default', rawPath: '/a', requestContext: { http: { method: 'GET' } } });
    expect(t.attributes['http.route']).toBeUndefined();
  });

  it('function URL', () => {
    const t = detectTrigger({
      version: '2.0',
      routeKey: '$default',
      rawPath: '/hook',
      requestContext: { domainName: 'abc.lambda-url.eu-west-1.on.aws', http: { method: 'POST', path: '/hook' } },
    });
    expect(t).toMatchObject({ source: 'aws:function-url', trigger: 'http', kind: SpanKind.SERVER });
  });

  it('ALB', () => {
    const t = detectTrigger({ httpMethod: 'GET', path: '/health?x=1', requestContext: { elb: { targetGroupArn: 'arn' } } });
    expect(t.source).toBe('aws:alb');
    expect(t.attributes['url.path']).toBe('/health');
  });

  it('SQS', () => {
    const t = detectTrigger({
      Records: [{ eventSource: 'aws:sqs', messageId: 'm1', eventSourceARN: 'arn:aws:sqs:eu-west-1:1:jobs' }],
    });
    expect(t).toMatchObject({ source: 'aws:sqs', trigger: 'pubsub', kind: SpanKind.CONSUMER });
    expect(t.attributes).toMatchObject({ 'messaging.system': 'aws_sqs', 'messaging.destination.name': 'jobs', 'messaging.message.id': 'm1' });
  });

  it('SNS', () => {
    const t = detectTrigger({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: 'arn:aws:sns:eu-west-1:1:alerts', MessageId: 'x' } }] });
    expect(t).toMatchObject({ source: 'aws:sns', trigger: 'pubsub' });
    expect(t.attributes['messaging.destination.name']).toBe('alerts');
  });

  it('S3', () => {
    const t = detectTrigger({ Records: [{ eventSource: 'aws:s3', eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'b' }, object: { key: 'k.txt' } } }] });
    expect(t).toMatchObject({ source: 'aws:s3', trigger: 'datasource', kind: SpanKind.CONSUMER });
    expect(t.attributes).toMatchObject({ 'aws.s3.bucket': 'b', 'aws.s3.key': 'k.txt' });
  });

  it('DynamoDB streams', () => {
    const t = detectTrigger({
      Records: [{ eventSource: 'aws:dynamodb', eventSourceARN: 'arn:aws:dynamodb:eu-west-1:1:table/users/stream/2024' }],
    });
    expect(t).toMatchObject({ source: 'aws:dynamodb', trigger: 'datasource' });
    expect(t.attributes['aws.dynamodb.table_names']).toEqual(['users']);
  });

  it('Kinesis', () => {
    const t = detectTrigger({ Records: [{ eventSource: 'aws:kinesis', eventSourceARN: 'arn:aws:kinesis:eu-west-1:1:stream/clicks' }] });
    expect(t).toMatchObject({ source: 'aws:kinesis', trigger: 'pubsub' });
    expect(t.attributes['messaging.destination.name']).toBe('clicks');
  });

  it('EventBridge', () => {
    const t = detectTrigger({ source: 'com.example', 'detail-type': 'OrderPlaced', detail: {} });
    expect(t).toMatchObject({ source: 'aws:eventbridge', trigger: 'pubsub' });
  });

  it('scheduled', () => {
    const t = detectTrigger({ source: 'aws.events', 'detail-type': 'Scheduled Event', resources: ['arn:aws:events:x:1:rule/nightly'] });
    expect(t).toMatchObject({ source: 'aws:scheduled', trigger: 'timer', kind: SpanKind.INTERNAL });
    expect(t.attributes['ivy.trigger.rule']).toBe('nightly');
  });

  it('direct invocation', () => {
    expect(detectTrigger({ foo: 1 })).toMatchObject({ source: 'aws:lambda', trigger: 'other', kind: SpanKind.INTERNAL });
    expect(detectTrigger(null).source).toBe('aws:lambda');
    expect(detectTrigger('x').source).toBe('aws:lambda');
  });

  it('unknown record source', () => {
    expect(detectTrigger({ Records: [{ eventSource: 'aws:mq' }] }).source).toBe('unknown');
  });
});

describe('httpStatusFromResult', () => {
  it('reads statusCode and defaults v2 to 200', () => {
    expect(httpStatusFromResult('aws:apigateway', { statusCode: 404 })).toBe(404);
    expect(httpStatusFromResult('aws:apigatewayv2', 'hello')).toBe(200);
    expect(httpStatusFromResult('aws:apigateway', 'hello')).toBeUndefined();
  });
});
