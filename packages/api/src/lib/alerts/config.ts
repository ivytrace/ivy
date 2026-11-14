import { publicUrl } from '../aws/config.js';
import { emailEnabled } from '../email/send.js';
import { serverSecret } from '../tenancy/secret-box.js';

const env = (name: string) => process.env[name]?.trim() || undefined;

export interface SlackConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  secret: string;
}

/**
 * Slack alerts need a Slack app (IVY_SLACK_CLIENT_ID, IVY_SLACK_CLIENT_SECRET), a public URL for the
 * OAuth redirect (IVY_PUBLIC_URL) and IVY_SECRET_KEY (webhook URLs are stored encrypted, the OAuth
 * state is signed). Null when any is missing: no Slack anywhere.
 */
export function slackConfig(): SlackConfig | null {
  const clientId = env('IVY_SLACK_CLIENT_ID');
  const clientSecret = env('IVY_SLACK_CLIENT_SECRET');
  const url = publicUrl();
  const secret = serverSecret();
  return clientId && clientSecret && url && secret ? { clientId, clientSecret, publicUrl: url, secret } : null;
}

export const slackEnabled = () => slackConfig() !== null;

const missing = (pairs: [string, string | null | undefined][]) => pairs.filter(([, v]) => !v).map(([k]) => k);

/** What Slack is missing, for the UI's explanation. */
export const slackMissing = () =>
  missing([
    ['IVY_SLACK_CLIENT_ID', env('IVY_SLACK_CLIENT_ID')],
    ['IVY_SLACK_CLIENT_SECRET', env('IVY_SLACK_CLIENT_SECRET')],
    ['IVY_PUBLIC_URL', publicUrl()],
    ['IVY_SECRET_KEY', serverSecret()],
  ]);

/** Slack's Web API and authorize page; tests point them at a fake server. */
export const slackApiUrl = () => (env('IVY_SLACK_API_URL') ?? 'https://slack.com/api').replace(/\/$/, '');
export const slackAuthorizeUrl = () => env('IVY_SLACK_AUTHORIZE_URL') ?? 'https://slack.com/oauth/v2/authorize';

/** The weekly digest needs SMTP (IVY_SMTP_URL, IVY_EMAIL_FROM) and IVY_PUBLIC_URL for its links. */
export const digestEnabled = () => emailEnabled() && !!publicUrl();

export const digestMissing = () =>
  missing([
    ['IVY_SMTP_URL', env('IVY_SMTP_URL')],
    ['IVY_EMAIL_FROM', env('IVY_EMAIL_FROM')],
    ['IVY_PUBLIC_URL', publicUrl()],
  ]);

/** When the digest goes out (UTC): five-field cron, default Monday 08:00. */
export const digestCron = () => env('IVY_DIGEST_CRON') ?? '0 8 * * 1';

/** Extra digest recipients for the default workspace (installs without sign-in have no members). */
export const digestExtraRecipients = () =>
  (env('IVY_DIGEST_TO') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@]+@[^\s@]+$/.test(s));

/** The background loop's period in seconds; 0 turns alerts and the digest off in this process. */
export const alertLoopMs = () => Number(env('IVY_ALERTS_INTERVAL_SECONDS') ?? 60) * 1000;

/** The key for signed links (OAuth state, unsubscribe): IVY_SECRET_KEY, else derived from the SMTP URL. */
export const signingSecret = () => serverSecret() ?? env('IVY_SMTP_URL') ?? null;
