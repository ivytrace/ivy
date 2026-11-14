import { stringify } from 'yaml';
import { COMPONENT_TAG } from './attach.js';
import { LAYER_NAME, EVENT_SECRET_HEADER } from './config.js';

export interface TemplateParams {
  principalArn: string | null;
  externalId?: string;
  roleName?: string;
  eventsUrl?: string | null;
  eventSecret?: string;
}

const tags = (value: string) => [{ Key: COMPONENT_TAG, Value: value }];
const sub = (s: string) => ({ 'Fn::Sub': s });
const ref = (name: string) => ({ Ref: name });

/**
 * CloudFormation template for a connected account. Defaults are filled in from `params` so a
 * downloaded template can be uploaded in the console without typing anything; the quick-create
 * link passes the same values as `param_*` query parameters.
 */
export function buildTemplate(params: TemplateParams): Record<string, unknown> {
  const withDefault = (def: Record<string, unknown>, value: string | null | undefined) =>
    value !== undefined && value !== null ? { ...def, Default: value } : def;

  const layerArn = `arn:\${AWS::Partition}:lambda:*:\${AWS::AccountId}:layer:${LAYER_NAME}`;

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Ivy Trace: cross-account role that lets Ivy attach its tracing layer to Node.js Lambda functions',
    Parameters: {
      TrustedPrincipalArn: withDefault(
        { Type: 'String', Description: 'The Ivy Trace AWS principal allowed to assume the role', AllowedPattern: '^arn:aws[\\w-]*:(iam|sts)::\\d{12}:.+$' },
        params.principalArn,
      ),
      ExternalId: withDefault(
        { Type: 'String', Description: 'External ID Ivy Trace sends when assuming the role', MinLength: 16 },
        params.externalId,
      ),
      RoleName: withDefault({ Type: 'String', Description: 'Name of the role Ivy Trace assumes', Default: 'IvyTraceAccess' }, params.roleName),
      EventsUrl: withDefault(
        {
          Type: 'String',
          Description: 'Optional HTTPS URL of the Ivy Trace events endpoint, for attaching to new functions immediately',
          Default: '',
        },
        params.eventsUrl,
      ),
      EventSecret: withDefault(
        { Type: 'String', Description: 'Shared secret for the events endpoint', NoEcho: true, Default: '' },
        params.eventSecret,
      ),
    },
    Conditions: {
      EventsEnabled: { 'Fn::And': [{ 'Fn::Not': [{ 'Fn::Equals': [ref('EventsUrl'), ''] }] }, { 'Fn::Not': [{ 'Fn::Equals': [ref('EventSecret'), ''] }] }] },
    },
    Resources: {
      IvyTraceRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: ref('RoleName'),
          Description: 'Assumed by Ivy Trace to attach its tracing layer to Node.js Lambda functions',
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ref('TrustedPrincipalArn') },
                Action: 'sts:AssumeRole',
                Condition: { StringEquals: { 'sts:ExternalId': ref('ExternalId') } },
              },
            ],
          },
          Policies: [
            {
              PolicyName: 'ivy-trace-lambda-layer',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Sid: 'Functions',
                    Effect: 'Allow',
                    Action: [
                      'lambda:ListFunctions',
                      'lambda:GetFunction',
                      'lambda:GetFunctionConfiguration',
                      'lambda:UpdateFunctionConfiguration',
                      'lambda:ListLayerVersions',
                      'tag:GetResources',
                    ],
                    Resource: '*',
                  },
                  {
                    Sid: 'IvyLayer',
                    Effect: 'Allow',
                    Action: ['lambda:PublishLayerVersion', 'lambda:GetLayerVersion'],
                    Resource: [sub(layerArn), sub(`${layerArn}:*`)],
                  },
                ],
              },
            },
          ],
          Tags: tags('access-role'),
        },
      },
      EventsConnection: {
        Type: 'AWS::Events::Connection',
        Condition: 'EventsEnabled',
        Properties: {
          Description: 'Ivy Trace events endpoint',
          AuthorizationType: 'API_KEY',
          AuthParameters: { ApiKeyAuthParameters: { ApiKeyName: EVENT_SECRET_HEADER, ApiKeyValue: ref('EventSecret') } },
        },
      },
      EventsDestination: {
        Type: 'AWS::Events::ApiDestination',
        Condition: 'EventsEnabled',
        Properties: {
          ConnectionArn: { 'Fn::GetAtt': ['EventsConnection', 'Arn'] },
          InvocationEndpoint: ref('EventsUrl'),
          HttpMethod: 'POST',
          InvocationRateLimitPerSecond: 1,
        },
      },
      EventsRole: {
        Type: 'AWS::IAM::Role',
        Condition: 'EventsEnabled',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sts:AssumeRole' }],
          },
          Policies: [
            {
              PolicyName: 'invoke-ivy-events',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  { Effect: 'Allow', Action: 'events:InvokeApiDestination', Resource: { 'Fn::GetAtt': ['EventsDestination', 'Arn'] } },
                ],
              },
            },
          ],
          Tags: tags('events-role'),
        },
      },
      FunctionChangesRule: {
        Type: 'AWS::Events::Rule',
        Condition: 'EventsEnabled',
        Properties: {
          Description: 'Tells Ivy Trace about new and reconfigured Lambda functions (needs a CloudTrail trail)',
          EventPattern: {
            source: ['aws.lambda'],
            'detail-type': ['AWS API Call via CloudTrail'],
            detail: {
              eventSource: ['lambda.amazonaws.com'],
              eventName: [{ prefix: 'CreateFunction' }, { prefix: 'UpdateFunctionConfiguration' }],
            },
          },
          Targets: [
            {
              Id: 'ivy-trace',
              Arn: { 'Fn::GetAtt': ['EventsDestination', 'Arn'] },
              RoleArn: { 'Fn::GetAtt': ['EventsRole', 'Arn'] },
            },
          ],
        },
      },
    },
    Outputs: {
      RoleArn: { Description: 'Role assumed by Ivy Trace', Value: { 'Fn::GetAtt': ['IvyTraceRole', 'Arn'] } },
      ExternalId: { Description: 'External ID', Value: ref('ExternalId') },
    },
  };
}

export function templateYaml(params: TemplateParams): string {
  return stringify(buildTemplate(params), { lineWidth: 0, aliasDuplicateObjects: false });
}

export interface QuickCreateParams {
  templateUrl: string;
  region: string;
  stackName: string;
  principalArn: string | null;
  externalId: string;
  roleName: string;
  eventsUrl: string | null;
  eventSecret: string;
}

export function quickCreateUrl(p: QuickCreateParams): string {
  const query = new URLSearchParams({
    templateURL: p.templateUrl,
    stackName: p.stackName,
    param_ExternalId: p.externalId,
    param_RoleName: p.roleName,
  });
  if (p.principalArn) query.set('param_TrustedPrincipalArn', p.principalArn);
  if (p.eventsUrl) {
    query.set('param_EventsUrl', p.eventsUrl);
    query.set('param_EventSecret', p.eventSecret);
  }
  return `https://${p.region}.console.aws.amazon.com/cloudformation/home?region=${p.region}#/stacks/quickcreate?${query}`;
}
