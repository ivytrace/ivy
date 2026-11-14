import { describe, expect, it } from 'vitest';
import { awsServiceAttributes, operationFromCommandName, operationFromHttp, parseSigV4, serviceFromClientName, serviceFromSigningName } from './aws-attributes.js';

describe('aws attributes', () => {
  it('names services and operations', () => {
    expect(serviceFromClientName('DynamoDBClient')).toBe('DynamoDB');
    expect(serviceFromClientName('EventBridgeClient')).toBe('EventBridge');
    expect(operationFromCommandName('GetItemCommand')).toBe('GetItem');
    expect(serviceFromSigningName('events')).toBe('EventBridge');
    expect(serviceFromSigningName('secretsmanager')).toBe('SecretsManager');
  });

  it('DynamoDB table names from single, batch and transact inputs', () => {
    expect(awsServiceAttributes('DynamoDB', { TableName: 'arn:aws:dynamodb:eu-west-1:1:table/users' }, {})).toEqual({ 'aws.dynamodb.table_names': ['users'] });
    expect(awsServiceAttributes('DynamoDB', { RequestItems: { a: [], b: [] } }, {})['aws.dynamodb.table_names']).toEqual(['a', 'b']);
    expect(
      awsServiceAttributes('DynamoDB', { TransactItems: [{ Put: { TableName: 'x' } }, { Update: { TableName: 'y' } }, { Put: { TableName: 'x' } }] }, {})[
        'aws.dynamodb.table_names'
      ],
    ).toEqual(['x', 'y']);
  });

  it('S3, SQS, SNS, Lambda, EventBridge', () => {
    expect(awsServiceAttributes('S3', { Bucket: 'b', Key: 'k' }, {})).toEqual({ 'aws.s3.bucket': 'b', 'aws.s3.key': 'k' });
    expect(awsServiceAttributes('SQS', { QueueUrl: 'https://sqs.eu-west-1.amazonaws.com/1/jobs' }, { MessageId: 'm' })).toEqual({
      'messaging.system': 'aws_sqs',
      'messaging.destination.name': 'jobs',
      'messaging.message.id': 'm',
    });
    expect(awsServiceAttributes('SNS', { TopicArn: 'arn:aws:sns:eu-west-1:1:alerts' }, { MessageId: 'n' })['messaging.destination.name']).toBe('alerts');
    expect(awsServiceAttributes('Lambda', { FunctionName: 'arn:aws:lambda:us-east-1:1:function:other:live' }, {}, 'eu-west-1')).toEqual({
      'faas.invoked_name': 'other',
      'faas.invoked_region': 'us-east-1',
    });
    expect(awsServiceAttributes('Lambda', { FunctionName: 'local' }, {}, 'eu-west-1')).toEqual({ 'faas.invoked_name': 'local', 'faas.invoked_region': 'eu-west-1' });
    expect(
      awsServiceAttributes('EventBridge', { Entries: [{ EventBusName: 'orders', DetailType: 'A' }, { DetailType: 'B' }, { DetailType: 'A' }] }, {}),
    ).toEqual({ 'aws.eventbridge.bus': 'orders', 'aws.eventbridge.detail_types': ['A', 'B'] });
  });

  it('parses SigV4 scope and HTTP-level operations', () => {
    expect(parseSigV4('AWS4-HMAC-SHA256 Credential=AKIA/20241121/eu-west-1/dynamodb/aws4_request, SignedHeaders=host, Signature=x')).toEqual({
      region: 'eu-west-1',
      service: 'dynamodb',
    });
    expect(parseSigV4('Bearer x')).toBeUndefined();
    expect(operationFromHttp('DynamoDB_20120810.PutItem', undefined)).toBe('PutItem');
    expect(operationFromHttp(undefined, 'Action=Publish&TopicArn=x')).toBe('Publish');
  });
});
