/** Commercial regions with Lambda. Opt-in regions that aren't enabled in an account are skipped at sync time. */
export const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-south-1',
  'eu-south-2',
  'eu-north-1',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
];

export const isRegion = (value: string) => /^[a-z]{2}(-[a-z]+)+-\d$/.test(value);

/** Errors Lambda returns for a region that is not enabled in the account. */
export function isRegionDisabledError(err: unknown): boolean {
  const name = (err as Error)?.name ?? '';
  return ['UnrecognizedClientException', 'InvalidClientTokenId', 'AuthFailure', 'OptInRequired'].includes(name);
}
