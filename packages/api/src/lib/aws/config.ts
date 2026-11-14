import { existsSync } from 'node:fs';
import path from 'node:path';

export const LAYER_NAME = 'ivy-trace-nodejs';
export const EXEC_WRAPPER = '/opt/ivy-wrapper';
export const EVENT_SECRET_HEADER = 'x-ivy-event-secret';
export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;

export interface IngestConfig {
  endpoint: string;
  apiKey: string;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

/** Ingest settings written into each traced function. Single-tenant for now; M6 maps tenants to their own keys. */
export function ingestConfig(_tenant: string): IngestConfig | null {
  const endpoint = env('IVY_INGEST_PUBLIC_URL');
  const apiKey = env('IVY_INGEST_API_KEY');
  if (!endpoint || !apiKey) return null;
  return { endpoint: endpoint.replace(/\/$/, ''), apiKey };
}

export const cfnTemplateUrl = () => env('IVY_CFN_TEMPLATE_URL') ?? null;

export const publicUrl = () => env('IVY_PUBLIC_URL')?.replace(/\/$/, '') ?? null;

/** EventBridge API destinations only call HTTPS endpoints, so events are only offered for an HTTPS public URL. */
export function eventsUrl(): string | null {
  const url = publicUrl();
  return url?.startsWith('https://') ? `${url}/api/aws/events` : null;
}

export const defaultRegion = () => env('IVY_AWS_DEFAULT_REGION') ?? 'us-east-1';

export const stsRegion = () => env('IVY_AWS_REGION') ?? env('AWS_REGION') ?? env('AWS_DEFAULT_REGION') ?? 'us-east-1';

export function syncIntervalMs(): number {
  const value = env('IVY_AWS_SYNC_INTERVAL_SECONDS');
  if (value === undefined) return DEFAULT_SYNC_INTERVAL_MS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export function layerZipPath(): string | null {
  const candidates = [
    env('IVY_LAYER_ZIP'),
    path.resolve(process.cwd(), 'layer.zip'),
    path.resolve(process.cwd(), '../layer/dist/layer.zip'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}
