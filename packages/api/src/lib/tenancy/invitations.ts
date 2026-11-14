import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { AuthUser } from '../auth/user.js';
import type { VerifiedEmail } from '../auth/userinfo.js';
import { emailEnabled, sendEmail } from '../email/send.js';
import { hashKey, newInvitationId } from './ids.js';
import { forgetMemberships } from './members.js';
import { tenancyStore, type InvitationRecord, type MemberRole, type TenantRecord } from './store.js';

export const INVITATION_TTL_MS = 7 * 24 * 3600_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export function invitationStatus(inv: InvitationRecord, now = Date.now()): InvitationStatus {
  if (inv.accepted_at !== null) return 'accepted';
  if (inv.revoked_at !== null) return 'revoked';
  if (inv.expires_at <= now) return 'expired';
  return 'pending';
}

export const inviteUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/invite/${token}`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function inviteEmail(workspace: TenantRecord, inviter: string, url: string) {
  const who = inviter || 'Someone';
  return {
    subject: `${who} invited you to ${workspace.name} on Ivy`,
    text: `${who} invited you to the Ivy workspace "${workspace.name}".\n\nAccept the invitation: ${url}\n\nThe link works once and expires in 7 days. Sign in with this email address to accept it.\n`,
    html: `<p>${escapeHtml(who)} invited you to the Ivy workspace <strong>${escapeHtml(workspace.name)}</strong>.</p>
<p><a href="${escapeHtml(url)}">Accept the invitation</a></p>
<p style="color:#71717a">The link works once and expires in 7 days. Sign in with this email address to accept it.</p>`,
  };
}

export interface CreatedInvitation {
  invitation: InvitationRecord;
  /** Shown to the inviter once (only the hash is stored). */
  url: string;
  emailSent: boolean;
  emailError: string | null;
}

/**
 * Invites `email` to a workspace. The token goes only into the link (shown to the inviter, and
 * emailed when SMTP is configured); Ivy keeps sha256(token). A new invitation for the same email
 * revokes the previous pending one.
 */
export async function createInvitation(
  workspace: TenantRecord,
  inviter: AuthUser | null,
  input: { email?: unknown; role?: unknown },
  origin: string,
): Promise<CreatedInvitation> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new HTTPException(400, { message: 'email must be an email address' });
  const role = input.role ?? 'member';
  if (role !== 'owner' && role !== 'member') throw new HTTPException(400, { message: 'role must be "owner" or "member"' });
  const store = tenancyStore();
  if ((await store.listMembers(workspace.id)).some((m) => m.email.toLowerCase() === email)) {
    throw new HTTPException(409, { message: `${email} is already a member` });
  }
  const now = Date.now();
  for (const inv of await store.listInvitations(workspace.id)) {
    if (inv.email === email && invitationStatus(inv, now) === 'pending') await store.saveInvitation({ ...inv, revoked_at: now });
  }
  const token = randomBytes(32).toString('base64url');
  const invitation: InvitationRecord = {
    tenant_id: workspace.id,
    id: newInvitationId(),
    email,
    role: role as MemberRole,
    token_hash: hashKey(token),
    invited_by: inviter?.sub ?? '',
    invited_by_email: inviter?.email ?? '',
    created_at: now,
    expires_at: now + INVITATION_TTL_MS,
    accepted_at: null,
    accepted_by: '',
    revoked_at: null,
  };
  await store.saveInvitation(invitation);
  const url = inviteUrl(origin, token);
  let emailSent = false;
  let emailError: string | null = null;
  if (emailEnabled()) {
    try {
      await sendEmail({ to: email, ...inviteEmail(workspace, inviter?.email || inviter?.name || '', url) });
      emailSent = true;
    } catch (err) {
      emailError = (err as Error).message;
      console.error(`invitation email to ${email} failed:`, err);
    }
  }
  return { invitation, url, emailSent, emailError };
}

export async function revokeInvitation(tenantId: string, id: string): Promise<InvitationRecord> {
  const store = tenancyStore();
  const inv = (await store.listInvitations(tenantId)).find((i) => i.id === id);
  if (!inv) throw new HTTPException(404, { message: 'Invitation not found' });
  if (invitationStatus(inv) !== 'pending') throw new HTTPException(409, { message: `The invitation is already ${invitationStatus(inv)}` });
  const revoked = { ...inv, revoked_at: Date.now() };
  await store.saveInvitation(revoked);
  return revoked;
}

/** The invitation behind a link and its workspace; 404 for an unknown token or a deleted workspace. */
export async function lookupInvitation(token: string): Promise<{ invitation: InvitationRecord; workspace: TenantRecord }> {
  const invitation = token ? await tenancyStore().findInvitationByTokenHash(hashKey(token)) : null;
  const workspace = invitation && (await tenancyStore().getTenant(invitation.tenant_id));
  if (!invitation || !workspace) throw new HTTPException(404, { message: 'This invitation link is not valid' });
  return { invitation, workspace };
}

const GONE: Record<Exclude<InvitationStatus, 'pending'>, string> = {
  accepted: 'This invitation has already been used',
  revoked: 'This invitation was revoked; ask for a new one',
  expired: 'This invitation has expired; ask for a new one',
};

/**
 * Accepts an invitation for the signed-in user. Requires the token to be pending (single use, not
 * expired or revoked) and the user's email, as verified by the identity provider, to be the invited
 * one (case-insensitive).
 */
export async function acceptInvitation(token: string, user: AuthUser, email: VerifiedEmail): Promise<{ workspace: TenantRecord; role: MemberRole }> {
  const { invitation, workspace } = await lookupInvitation(token);
  const status = invitationStatus(invitation);
  if (status !== 'pending') throw new HTTPException(410, { message: GONE[status] });
  if (!email.email || email.email.trim().toLowerCase() !== invitation.email) {
    throw new HTTPException(403, {
      message: `This invitation is for ${invitation.email}, but you're signed in as ${email.email ?? 'an account without an email address'}. Sign in with ${invitation.email} to accept it.`,
    });
  }
  if (!email.verified) {
    throw new HTTPException(403, {
      message: `Your identity provider hasn't verified ${email.email} yet. Verify your email address, then open this link again.`,
    });
  }
  const store = tenancyStore();
  const existing = (await store.listMembers(workspace.id)).find((m) => m.sub === user.sub);
  const role: MemberRole = existing?.role === 'owner' ? 'owner' : invitation.role;
  await store.saveInvitation({ ...invitation, accepted_at: Date.now(), accepted_by: user.sub });
  await store.saveMember({ tenant_id: workspace.id, sub: user.sub, email: email.email, role, created_at: existing?.created_at ?? Date.now() });
  forgetMemberships(user.sub);
  return { workspace, role };
}

export const presentInvitation = (inv: InvitationRecord) => ({
  id: inv.id,
  email: inv.email,
  role: inv.role,
  status: invitationStatus(inv),
  invited_by: inv.invited_by_email || null,
  created_at: new Date(inv.created_at).toISOString(),
  expires_at: new Date(inv.expires_at).toISOString(),
  accepted_at: inv.accepted_at === null ? null : new Date(inv.accepted_at).toISOString(),
});
