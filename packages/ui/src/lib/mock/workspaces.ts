import type { ApiKey, Invitation, Member, Project, Role, Workspace } from "../api/types.ts";

/** Mock control plane: workspaces, projects, members, invitations and ingest keys. */

export interface MockWorkspace extends Workspace {
  projects: Project[];
  members: Member[];
  invitations: (Invitation & { token: string })[];
  keys: (ApiKey & { project: string })[];
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let counter = 0;
const id = (prefix: string) => `${prefix}_mock${(++counter).toString(36).padStart(6, "0")}`;

export const slugOk = (s: string) => /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/.test(s);

/** Like the API: the slug of `name`, else `fallback`; `-2`, `-3`, … while `taken`. */
export function slugFrom(name: string, taken: (slug: string) => boolean, fallback = "project"): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || fallback;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 40 - String(n).length - 1).replace(/-+$/, "")}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

export function project(slug: string, name: string, ageDays: number, extra: Partial<Project> = {}): Project {
  return { id: id("prj"), slug, name, archived: false, default: false, created_at: iso(Date.now() - ageDays * DAY), ...extra };
}

function key(projectSlug: string, name: string, kind: ApiKey["kind"], ageDays: number) {
  return { id: id("key"), name, kind, prefix: `ivy_${Math.random().toString(36).slice(2, 8)}`, created_at: iso(Date.now() - ageDays * DAY), revoked_at: null, project: projectSlug };
}

export function newWorkspace(name: string, slug: string, role: Role, ageDays = 0): MockWorkspace {
  return {
    id: id("ten"),
    slug,
    name,
    role,
    default: false,
    created_at: iso(Date.now() - ageDays * DAY),
    projects: [project("default", "Default", ageDays, { default: true })],
    members: [{ sub: "idn_you", email: "you@example.com", role, you: true, joined_at: iso(Date.now() - ageDays * DAY) }],
    invitations: [],
    keys: [],
  };
}

export function seedWorkspaces(empty: boolean): MockWorkspace[] {
  if (empty) return [newWorkspace("Personal", "personal", "owner")];

  const acme = newWorkspace("Acme", "acme", "owner", 40);
  acme.projects = [
    project("checkout-prod", "Checkout (prod)", 30),
    project("checkout-staging", "Checkout (staging)", 30),
    project("billing-api-prod", "Billing API (prod)", 20),
    project("billing-api-staging", "Billing API (staging)", 20),
    project("support-api-prod", "Support API (prod)", 10),
    project("default", "Default", 40, { default: true }),
    project("legacy-reports", "Legacy reports", 60, { archived: true }),
  ];
  acme.members.push(
    { sub: "idn_dana", email: "dana@example.com", role: "owner", you: false, joined_at: iso(Date.now() - 35 * DAY) },
    { sub: "idn_sam", email: "sam@example.com", role: "member", you: false, joined_at: iso(Date.now() - 12 * DAY) },
  );
  acme.invitations.push({
    id: id("inv"),
    email: "lee@example.com",
    role: "member",
    status: "pending",
    invited_by: "you@example.com",
    created_at: iso(Date.now() - 2 * DAY),
    expires_at: iso(Date.now() + 5 * DAY),
    accepted_at: null,
    token: "mock-invite-token",
  });
  acme.keys.push(
    key("checkout-prod", "Auto-trace (Lambda functions)", "auto-trace", 30),
    key("checkout-prod", "ci", "user", 10),
    key("billing-api-prod", "Auto-trace (Lambda functions)", "auto-trace", 20),
    key("support-api-prod", "Auto-trace (Lambda functions)", "auto-trace", 10),
  );

  // Someone else's workspace you're a member of: only the untouched default project (onboarding).
  const side = newWorkspace("Side project", "side-project", "member", 3);
  side.members.unshift({ sub: "idn_kim", email: "kim@example.com", role: "owner", you: false, joined_at: iso(Date.now() - 3 * DAY) });
  return [acme, side];
}

export const newKey = (projectSlug: string, name: string) => {
  const k = key(projectSlug, name, "user", 0);
  return { record: k, key: `ivy_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 44) };
};

export const newInvitation = (email: string, role: Role) => {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return {
    id: id("inv"),
    email,
    role,
    status: "pending" as const,
    invited_by: "you@example.com",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    accepted_at: null,
    token,
  };
};

export const newProject = (slug: string, name: string) => project(slug, name, 0);

export const newWorkspaceId = () => id("ten");
