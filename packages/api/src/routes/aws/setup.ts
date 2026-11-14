import type { Context } from 'hono';
import { principalArn } from '../../lib/aws/clients.js';
import { cfnTemplateUrl, defaultRegion, eventsUrl, ingestConfig, publicUrl, syncIntervalMs } from '../../lib/aws/config.js';
import { layerZip } from '../../lib/aws/lambda.js';
import { AWS_REGIONS } from '../../lib/aws/regions.js';
import { tenantOf } from '../../lib/clickhouse/tenant.js';

export async function getAwsSetup(c: Context) {
  const principal = await principalArn();
  const ingest = ingestConfig(tenantOf(c));
  const layer = layerZip();
  const issues: string[] = [];
  if (!principal) issues.push('No AWS credentials found. Set IVY_AWS_PRINCIPAL_ARN and give the server credentials through the standard AWS SDK chain.');
  if (!ingest) issues.push('IVY_INGEST_PUBLIC_URL and IVY_INGEST_API_KEY must be set so functions know where to send traces.');
  if (!layer) issues.push('The layer zip was not found on the server (IVY_LAYER_ZIP).');

  return c.json({
    principal_arn: principal,
    template_url: cfnTemplateUrl(),
    events_url: eventsUrl(),
    public_url: publicUrl(),
    ingest_endpoint: ingest?.endpoint ?? null,
    layer_sha256: layer?.sha256 ?? null,
    default_region: defaultRegion(),
    regions: AWS_REGIONS,
    sync_interval_seconds: syncIntervalMs() / 1000,
    issues,
  });
}
