import { HTTPException } from 'hono/http-exception';
import { badRequest } from '../utils/http-error.js';
import { slackEnabled, slackMissing } from './config.js';
import type { AlertSettings, SlackIntegration } from './store.js';

export const presentIntegration = (i: SlackIntegration) => ({
  id: i.id,
  team_name: i.team_name,
  channel: i.channel,
  status: i.status,
  error: i.error || null,
  configuration_url: i.configuration_url || null,
  created_at: new Date(i.created_at).toISOString(),
});

export const slackAvailability = () => ({ slack: slackEnabled(), missing: slackMissing() });

export function requireSlack() {
  if (!slackEnabled()) {
    throw new HTTPException(409, { message: `Slack is not configured on this server (missing ${slackMissing().join(', ')})` });
  }
}

const LIMITS = { interval_minutes: [1, 7 * 24 * 60], every_occurrences: [1, 1_000_000] } as const;

/** Merges a partial update into the settings; 400 on anything malformed. */
export function parseSettings(body: Record<string, unknown>, current: AlertSettings): AlertSettings {
  const next = { ...current };
  for (const key of ['slack_enabled', 'include_throttles'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw badRequest(`${key} must be a boolean`);
    next[key] = body[key];
  }
  for (const key of ['interval_minutes', 'every_occurrences'] as const) {
    if (body[key] === undefined) continue;
    const v = body[key];
    const [min, max] = LIMITS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badRequest(`${key} must be a whole number from ${min} to ${max}`);
    next[key] = v;
  }
  return next;
}
