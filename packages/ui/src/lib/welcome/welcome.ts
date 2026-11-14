/** The first-run setup wizard: `/welcome/<step>?ws=&project=&account=&from=` (progress lives in the URL). */

export const WELCOME_STEPS = ["workspace", "project", "aws", "listen"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];

export interface WelcomeState {
  ws: string;
  project?: string;
  account?: string;
  /** `invite`: the user joined through an invitation, so the workspace step is skipped. */
  from?: string;
  /** `manual`: the aws step shows the ingest key instead of the AWS connect flow. */
  mode?: string;
}

export function welcomeLink(step: WelcomeStep, state: WelcomeState): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v) params.set(k, v);
  return `/welcome/${step}?${params}`;
}

/** The step to start at: the workspace step only for a new workspace in multi-workspace mode. */
export const firstStep = (multi: boolean, fromInvite: boolean): WelcomeStep => (multi && !fromInvite ? "workspace" : "project");

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "yahoo.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "fastmail.com", "hey.com", "gmx.com", "gmx.net",
  "gmx.de", "web.de", "mail.com", "zoho.com", "yandex.com", "example.com",
]);

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A workspace name to suggest: the company from a work email's domain (`erin@acme.io` → "Acme"),
 * else "<first name>'s workspace".
 */
export function suggestWorkspaceName(email: string | undefined | null, name: string | undefined | null): string {
  const domain = email?.split("@")[1]?.toLowerCase();
  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    const parts = domain.split(".");
    const company = parts.length > 2 && ["co", "com", "org", "net", "ac"].includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
    if (company) return company.split("-").map(capitalize).join(" ");
  }
  const first = (name?.trim().split(/\s+/)[0] || email?.split("@")[0]?.split(/[._+-]/)[0] || "").trim();
  return first ? `${capitalize(first)}'s workspace` : "My workspace";
}

const seenKey = (ws: string) => `ivy.welcomeSeen.${ws}`;

/** Whether the wizard was finished or skipped for this workspace (in this browser). */
export function welcomeSeen(ws: string): boolean {
  try {
    return localStorage.getItem(seenKey(ws)) === "1";
  } catch {
    return true;
  }
}

export function markWelcomeSeen(ws: string) {
  try {
    localStorage.setItem(seenKey(ws), "1");
  } catch {
    // storage unavailable: the wizard may show again
  }
}

const INVITE_KEY = "ivy.joinedByInvite";

/** Set by the invite page, so the wizard (if it shows) skips naming the workspace the user just joined. */
export function rememberJoinedByInvite(ws: string) {
  try {
    sessionStorage.setItem(INVITE_KEY, ws);
  } catch {
    // ignore
  }
}

export function joinedByInvite(ws: string): boolean {
  try {
    return sessionStorage.getItem(INVITE_KEY) === ws;
  } catch {
    return false;
  }
}
