import type { Attributes } from '../tracer/span.js';

const SIGNING_NAME_TO_SERVICE: Record<string, string> = {
  dynamodb: 'DynamoDB',
  s3: 'S3',
  sqs: 'SQS',
  sns: 'SNS',
  lambda: 'Lambda',
  events: 'EventBridge',
  ses: 'SES',
  secretsmanager: 'SecretsManager',
  kinesis: 'Kinesis',
  firehose: 'Firehose',
  states: 'SFN',
  ssm: 'SSM',
  sts: 'STS',
  kms: 'KMS',
  'cognito-idp': 'CognitoIdentityProvider',
  scheduler: 'Scheduler',
  bedrock: 'Bedrock',
  execute: 'ApiGatewayManagementApi',
  cloudwatch: 'CloudWatch',
  logs: 'CloudWatchLogs',
};

export function serviceFromClientName(clientName: unknown): string | undefined {
  if (typeof clientName !== 'string' || !clientName) return undefined;
  return clientName.replace(/Client$/, '') || undefined;
}

export function serviceFromSigningName(name: string): string {
  return SIGNING_NAME_TO_SERVICE[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

export function operationFromCommandName(commandName: unknown): string | undefined {
  if (typeof commandName !== 'string' || !commandName) return undefined;
  return commandName.replace(/Command$/, '') || undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function tableName(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /:table\/([^/]+)/.exec(s);
  return m ? m[1] : s;
}

function dynamoTables(input: any): string[] {
  const names = new Set<string>();
  const add = (v: unknown) => {
    const t = tableName(v);
    if (t) names.add(t);
  };
  add(input.TableName);
  if (input.RequestItems && typeof input.RequestItems === 'object') Object.keys(input.RequestItems).forEach(add);
  if (Array.isArray(input.TransactItems)) {
    for (const item of input.TransactItems) {
      for (const op of ['Get', 'Put', 'Update', 'Delete', 'ConditionCheck']) add(item?.[op]?.TableName);
    }
  }
  if (typeof input.Statement === 'string') {
    const m = /\b(?:from|into|update)\s+"?([A-Za-z0-9_.-]+)"?/i.exec(input.Statement);
    if (m) add(m[1]);
  }
  return [...names];
}

/** Service-specific attributes from an AWS SDK command input/output (see span conventions). */
export function awsServiceAttributes(service: string, input: unknown, output: unknown, region?: string): Attributes {
  const attrs: Attributes = {};
  const i = (input && typeof input === 'object' ? input : {}) as any;
  const o = (output && typeof output === 'object' ? output : {}) as any;
  switch (service) {
    case 'DynamoDB': {
      const tables = dynamoTables(i);
      if (tables.length) attrs['aws.dynamodb.table_names'] = tables;
      break;
    }
    case 'S3':
      if (str(i.Bucket)) attrs['aws.s3.bucket'] = i.Bucket;
      if (str(i.Key)) attrs['aws.s3.key'] = i.Key;
      break;
    case 'SQS': {
      attrs['messaging.system'] = 'aws_sqs';
      const queue = str(i.QueueUrl)?.split('/').pop() ?? str(i.QueueName);
      if (queue) attrs['messaging.destination.name'] = queue;
      if (str(o.MessageId)) attrs['messaging.message.id'] = o.MessageId;
      break;
    }
    case 'SNS': {
      attrs['messaging.system'] = 'aws_sns';
      const arn = str(i.TopicArn) ?? str(i.TargetArn);
      const topic = arn?.split(':').pop() ?? (str(i.PhoneNumber) ? 'phone' : undefined);
      if (topic) attrs['messaging.destination.name'] = topic;
      if (str(o.MessageId)) attrs['messaging.message.id'] = o.MessageId;
      break;
    }
    case 'Lambda': {
      const fn = str(i.FunctionName);
      if (fn) {
        const m = /^arn:[^:]+:lambda:([^:]+):[^:]+:function:([^:]+)/.exec(fn);
        attrs['faas.invoked_name'] = m ? m[2] : fn.split(':')[0];
        const r = m?.[1] ?? region;
        if (r) attrs['faas.invoked_region'] = r;
      }
      break;
    }
    case 'EventBridge': {
      const entries: any[] = Array.isArray(i.Entries) ? i.Entries : [];
      if (entries.length) {
        attrs['aws.eventbridge.bus'] = str(entries[0]?.EventBusName)?.split('/').pop() ?? 'default';
        const types = [...new Set(entries.map((e) => e?.DetailType).filter((t): t is string => typeof t === 'string'))];
        if (types.length) attrs['aws.eventbridge.detail_types'] = types;
      }
      break;
    }
  }
  return attrs;
}

/** Parses the SigV4 credential scope from an Authorization header: region and signing name. */
export function parseSigV4(authorization: unknown): { region: string; service: string } | undefined {
  if (typeof authorization !== 'string' || !authorization.startsWith('AWS4-HMAC-SHA256')) return undefined;
  const m = /Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/.exec(authorization);
  return m ? { region: m[1], service: m[2] } : undefined;
}

/** Operation name from an HTTP-level AWS request (JSON `X-Amz-Target` or query `Action=`). */
export function operationFromHttp(target: unknown, body: string | undefined): string | undefined {
  if (typeof target === 'string' && target.includes('.')) return target.slice(target.lastIndexOf('.') + 1);
  if (body) {
    const m = /(?:^|&)Action=([A-Za-z0-9]+)/.exec(body);
    if (m) return m[1];
  }
  return undefined;
}
