import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildTemplate, quickCreateUrl, templateYaml } from './template.js';

const PRINCIPAL = 'arn:aws:iam::999999999999:role/ivy-trace-hosted';

function cfnLint(): string | null {
  try {
    execFileSync('cfn-lint', ['--version'], { stdio: 'ignore' });
    return 'cfn-lint';
  } catch {
    return null;
  }
}

describe('CloudFormation template', () => {
  const full = { principalArn: PRINCIPAL, externalId: 'ivy-0123456789abcdef', roleName: 'IvyTrace-abc', eventsUrl: 'https://ivy.example.com/api/aws/events', eventSecret: 's3cret' };

  it('round-trips through YAML and has the expected structure', () => {
    const doc = parse(templateYaml(full));
    expect(doc).toEqual(buildTemplate(full));
    expect(doc.AWSTemplateFormatVersion).toBe('2010-09-09');
    expect(doc.Parameters.TrustedPrincipalArn.Default).toBe(PRINCIPAL);
    expect(doc.Parameters.ExternalId.Default).toBe(full.externalId);
    expect(doc.Parameters.EventSecret.NoEcho).toBe(true);

    const role = doc.Resources.IvyTraceRole.Properties;
    const trust = role.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Principal).toEqual({ AWS: { Ref: 'TrustedPrincipalArn' } });
    expect(trust.Condition).toEqual({ StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } } });

    const actions = role.Policies[0].PolicyDocument.Statement.flatMap((s: { Action: string[] }) => s.Action).sort();
    expect(actions).toEqual(
      [
        'cloudwatch:GetMetricData',
        'lambda:GetFunction',
        'lambda:GetFunctionConfiguration',
        'lambda:GetLayerVersion',
        'lambda:ListFunctions',
        'lambda:ListLayerVersions',
        'lambda:PublishLayerVersion',
        'lambda:UpdateFunctionConfiguration',
        'tag:GetResources',
      ].sort(),
    );

    for (const name of ['EventsConnection', 'EventsDestination', 'EventsRole', 'FunctionChangesRule']) {
      expect(doc.Resources[name].Condition).toBe('EventsEnabled');
    }
    expect(doc.Resources.FunctionChangesRule.Properties.EventPattern.detail.eventName).toEqual([
      { prefix: 'CreateFunction' },
      { prefix: 'UpdateFunctionConfiguration' },
    ]);
  });

  it('leaves the principal without default when Ivy has no AWS identity', () => {
    const doc = parse(templateYaml({ principalArn: null }));
    expect(doc.Parameters.TrustedPrincipalArn.Default).toBeUndefined();
    expect(doc.Parameters.ExternalId.Default).toBeUndefined();
    expect(doc.Parameters.EventsUrl.Default).toBe('');
  });

  it.runIf(cfnLint())('passes cfn-lint', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ivy-cfn-'));
    for (const [name, params] of Object.entries({ full, generic: { principalArn: PRINCIPAL } })) {
      const file = path.join(dir, `${name}.yaml`);
      writeFileSync(file, templateYaml(params));
      // Throws (non-zero exit) on any error or warning.
      execFileSync('cfn-lint', [file], { encoding: 'utf8' });
    }
  });
});

describe('quickCreateUrl', () => {
  it('points at the stack region console with the published template and no parameters', () => {
    const url = new URL(quickCreateUrl({ templateUrl: 'https://bucket.s3.amazonaws.com/t.yaml?X-Amz-Signature=abc', region: 'eu-west-1', stackName: 'ivy-trace-abc' }));
    expect(url.host).toBe('eu-west-1.console.aws.amazon.com');
    expect(url.searchParams.get('region')).toBe('eu-west-1');
    const params = new URLSearchParams(url.hash.split('?')[1]);
    expect(params.get('templateURL')).toBe('https://bucket.s3.amazonaws.com/t.yaml?X-Amz-Signature=abc');
    expect(params.get('stackName')).toBe('ivy-trace-abc');
    expect([...params.keys()].filter((k) => k.startsWith('param_'))).toEqual([]);
  });
});
