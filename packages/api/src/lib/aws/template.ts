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
 * CloudFormation template for a connected account. Defaults are filled in from `params` so the
 * template can be uploaded in the console (or opened from a quick-create link) without typing
 * anything. The event secret parameter is NoEcho.
 */
export function buildTemplate(params: TemplateParams): Record<string, unknown> {
  const withDefault = (def: Record<string, unknown>, value: string | null | undefined) =>
    value !== undefined && value !== null ? { ...def, Default: value } : def;

  const layerArn = `arn:\${AWS::Partition}:lambda:*:\${AWS::AccountId}:layer:${LAYER_NAME}`;

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Ivy: cross-account role that lets Ivy attach its tracing layer to Node.js Lambda functions',
    Parameters: {
      TrustedPrincipalArn: withDefault(
        { Type: 'String', Description: 'The Ivy AWS principal allowed to assume the role', AllowedPattern: '^arn:aws[\\w-]*:(iam|sts)::\\d{12}:.+$' },
        params.principalArn,
      ),
      ExternalId: withDefault(
        { Type: 'String', Description: 'External ID Ivy sends when assuming the role', MinLength: 16 },
        params.externalId,
      ),
      RoleName: withDefault({ Type: 'String', Description: 'Name of the role Ivy assumes', Default: 'IvyTraceAccess' }, params.roleName),
      EventsUrl: withDefault(
        {
          Type: 'String',
          Description: 'Optional HTTPS URL of the Ivy events endpoint, for attaching to new functions immediately',
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
          Description: 'Assumed by Ivy to attach its tracing layer to Node.js Lambda functions',
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
                  {
                    // Lambda throttles (AWS/Lambda Throttles); GetMetricData has no resource-level permissions.
                    Sid: 'ThrottleMetrics',
                    Effect: 'Allow',
                    Action: ['cloudwatch:GetMetricData'],
                    Resource: '*',
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
          Description: 'Ivy events endpoint',
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
          Description: 'Tells Ivy about new and reconfigured Lambda functions (needs a CloudTrail trail)',
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
      RoleArn: { Description: 'Role assumed by Ivy', Value: { 'Fn::GetAtt': ['IvyTraceRole', 'Arn'] } },
      ExternalId: { Description: 'External ID', Value: ref('ExternalId') },
    },
  };
}

export function templateYaml(params: TemplateParams): string {
  return stringify(buildTemplate(params), { lineWidth: 0, aliasDuplicateObjects: false });
}

export interface QuickCreateParams {
  /** Where CloudFormation fetches the connection's pre-filled template (from the publish-cfn-template hook). */
  templateUrl: string;
  region: string;
  stackName: string;
}

/**
 * Quick-create link for a published, pre-filled template. All values are defaults inside the
 * template, so the link carries no parameters, and in particular no secret.
 */
export function quickCreateUrl(p: QuickCreateParams): string {
  const query = new URLSearchParams({ templateURL: p.templateUrl, stackName: p.stackName });
  return `https://${p.region}.console.aws.amazon.com/cloudformation/home?region=${p.region}#/stacks/quickcreate?${query}`;
}
