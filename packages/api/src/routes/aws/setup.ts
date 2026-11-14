import type { Context } from 'hono';
import { principalArn } from '../../lib/aws/clients.js';
import { defaultRegion, eventsUrl, ingestEndpoint, publicUrl, syncIntervalMs } from '../../lib/aws/config.js';
import { layerZip } from '../../lib/aws/lambda.js';
import { quickCreateAvailable } from '../../lib/aws/publish.js';
import { AWS_REGIONS } from '../../lib/aws/regions.js';
import { serverSecret } from '../../lib/tenancy/secret-box.js';

export async function getAwsSetup(c: Context) {
  const principal = await principalArn();
  const endpoint = ingestEndpoint();
  const layer = layerZip();
  const issues: string[] = [];
  if (!principal) issues.push('No AWS credentials found. Set IVY_AWS_PRINCIPAL_ARN and give the server credentials through the standard AWS SDK chain.');
  if (!endpoint) issues.push('Set IVY_INGEST_PUBLIC_URL so functions know where to send traces.');
  if (!serverSecret()) {
    issues.push(
      process.env.IVY_INGEST_API_KEY?.trim()
        ? 'Set IVY_SECRET_KEY so Ivy can mint an ingest key per project; until then only the project of IVY_INGEST_API_KEY in the default workspace can be traced.'
        : 'Set IVY_SECRET_KEY so Ivy can mint an ingest key per project for traced functions.',
    );
  }
  if (!layer) issues.push('The layer zip was not found on the server (IVY_LAYER_ZIP).');

  return c.json({
    principal_arn: principal,
    quick_create: await quickCreateAvailable(),
    events_url: eventsUrl(),
    public_url: publicUrl(),
    ingest_endpoint: endpoint,
    layer_sha256: layer?.sha256 ?? null,
    default_region: defaultRegion(),
    regions: AWS_REGIONS,
    sync_interval_seconds: syncIntervalMs() / 1000,
    issues,
  });
}
