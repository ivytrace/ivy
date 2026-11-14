import { LambdaClient } from '@aws-sdk/client-lambda';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { stsRegion } from './config.js';
import type { AwsAccount } from './types.js';

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

const cache = new Map<string, Credentials>();
const REFRESH_MARGIN_MS = 5 * 60_000;

let sts: STSClient | undefined;
const stsClient = () => (sts ??= new STSClient({ region: stsRegion() }));

export function roleArnFor(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

/** Assumes the customer's role with Ivy's own credentials (standard SDK chain). */
export async function assumeRole(account: Pick<AwsAccount, 'role_arn' | 'external_id'>, fresh = false): Promise<Credentials> {
  const key = `${account.role_arn}|${account.external_id}`;
  const cached = cache.get(key);
  if (!fresh && cached && cached.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS) return cached;

  const { Credentials: c } = await stsClient().send(
    new AssumeRoleCommand({
      RoleArn: account.role_arn,
      ExternalId: account.external_id,
      RoleSessionName: 'ivy-trace',
      DurationSeconds: 3600,
    }),
  );
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('AssumeRole returned no credentials');
  const creds = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration ?? new Date(Date.now() + 3600_000),
  };
  cache.set(key, creds);
  return creds;
}

export function forgetCredentials(account: Pick<AwsAccount, 'role_arn' | 'external_id'>) {
  cache.delete(`${account.role_arn}|${account.external_id}`);
}

export interface RegionClients {
  lambda: LambdaClient;
  tagging: ResourceGroupsTaggingAPIClient;
}

export async function regionClients(account: AwsAccount, region: string): Promise<RegionClients> {
  const credentials = await assumeRole(account);
  const options = { region, credentials, maxAttempts: 5 };
  return { lambda: new LambdaClient(options), tagging: new ResourceGroupsTaggingAPIClient(options) };
}

/**
 * The principal customers trust. IVY_AWS_PRINCIPAL_ARN wins; otherwise it is derived from the
 * current credentials (an assumed-role session maps back to its role ARN).
 */
let principal: Promise<string | null> | undefined;

export function principalArn(): Promise<string | null> {
  const configured = process.env.IVY_AWS_PRINCIPAL_ARN?.trim();
  if (configured) return Promise.resolve(configured);
  principal ??= stsClient()
    .send(new GetCallerIdentityCommand({}))
    .then(({ Arn }) => (Arn ? principalFromCallerArn(Arn) : null))
    .catch(() => {
      principal = undefined;
      return null;
    });
  return principal;
}

export function principalFromCallerArn(arn: string): string {
  const assumed = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(arn);
  return assumed ? `arn:${assumed[1]}:iam::${assumed[2]}:role/${assumed[3]}` : arn;
}

export function resetAwsClientsForTests() {
  cache.clear();
  sts = undefined;
  principal = undefined;
}
