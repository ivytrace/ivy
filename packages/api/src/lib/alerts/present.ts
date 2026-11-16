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

const SETTING_KEYS = ['slack_enabled', 'interval_minutes', 'every_occurrences', 'include_throttles'] as const;

/** A complete rule (all four settings), as copied to other projects; 400 when one is missing or malformed. */
export function parseFullSettings(body: unknown): AlertSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('settings must be an object');
  const fields = body as Record<string, unknown>;
  const missing = SETTING_KEYS.filter((key) => fields[key] === undefined);
  if (missing.length) throw badRequest(`settings needs ${missing.join(', ')}`);
  return parseSettings(fields, { slack_enabled: true, interval_minutes: 1, every_occurrences: 1, include_throttles: false });
}
