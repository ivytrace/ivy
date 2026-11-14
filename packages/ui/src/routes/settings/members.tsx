import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Loader2, LogOut, Mail, Trash2, UserPlus } from "lucide-react";

import { SectionHeader } from "@/components/common/section-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { CopyButton } from "@/components/workspaces/key-reveal";
import { errorMessage } from "@/components/workspaces/name-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltipped } from "@/components/ui/tooltipped";
import { useConfig, useInvitations, useMembers, useMultiWorkspace, useWorkspaceInfo } from "@/lib/api/hooks";
import type { CreatedInvitation, Member, Role } from "@/lib/api/types";
import { inviteMember, refreshWorkspace, removeMember, revokeInvitation, setMemberRole } from "@/lib/api/workspaces";
import { useWorkspace } from "@/lib/links/use-scope";
import { formatAgo, formatDate } from "@/lib/utils/format";

export default function MembersSettings() {
  const workspace = useWorkspace();
  const multi = useMultiWorkspace();
  const info = useWorkspaceInfo(workspace);
  const owner = info.data?.role === "owner";

  if (!multi) {
    return (
      <EmptyState
        title="Members are managed by your identity provider"
        description="This install has a single workspace: everyone who can sign in can use it. Workspaces and invitations need IVY_SINGLE_TENANT=0."
      />
    );
  }
  return (
    <div>
      <SectionHeader title="Members" description="People who can use this workspace. Owners manage members, invitations and the workspace itself." />
      <MemberList workspace={workspace} owner={owner} />
      {owner && <Invitations workspace={workspace} />}
    </div>
  );
}

function MemberList({ workspace, owner }: { workspace: string; owner: boolean }) {
  const navigate = useNavigate();
  const members = useMembers(workspace);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(sub: string, action: () => Promise<unknown>, after?: () => void) {
    setBusy(sub);
    setError(null);
    try {
      await action();
      await refreshWorkspace(workspace);
      after?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (members.error) return <ErrorState error={members.error} onRetry={() => void members.mutate()} className="rounded-md border" />;
  if (!members.data) return <LoadingState className="rounded-md border" />;

  return (
    <div className="mb-10">
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="divide-y rounded-md border">
        {members.data.items.map((m: Member) => (
          <div key={m.sub} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-medium uppercase">
              {(m.email ?? m.sub).slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {m.email ?? m.sub}
                {m.you && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
              </div>
              <div className="text-xs text-muted-foreground">Joined {formatAgo(m.joined_at)}</div>
            </div>
            {owner ? (
              <Select value={m.role} onValueChange={(role) => void run(m.sub, () => setMemberRole(workspace, m.sub, role as Role))} disabled={busy === m.sub}>
                <SelectTrigger className="h-8 w-28" aria-label={`Role of ${m.email ?? m.sub}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <span className="text-sm capitalize text-muted-foreground">{m.role}</span>
            )}
            {(owner || m.you) && (
              <Tooltipped title={m.you ? "Leave workspace" : "Remove"}>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy === m.sub}
                  aria-label={m.you ? "Leave workspace" : `Remove ${m.email ?? m.sub}`}
                  onClick={() => void run(m.sub, () => removeMember(workspace, m.sub), m.you ? () => navigate("/", { replace: true }) : undefined)}
                >
                  {busy === m.sub ? <Loader2 className="size-4 animate-spin" /> : m.you ? <LogOut className="size-4" /> : <Trash2 className="size-4" />}
                </Button>
              </Tooltipped>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Invitations({ workspace }: { workspace: string }) {
  const { data: config } = useConfig();
  const invitations = useInvitations(workspace);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated(await inviteMember(workspace, { email: email.trim(), role }));
      setEmail("");
      await refreshWorkspace(workspace);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="mb-1 font-semibold">Invitations</h3>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        An invitation link works once, for 7 days, and only for someone who signs in with that email address (verified by the identity
        provider).{config?.email?.enabled ? " Ivy also emails the link." : ""}
      </p>
      <form onSubmit={(e) => void invite(e)} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" className="w-72" />
        </div>
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger className="w-28" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="owner">Owner</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <UserPlus className="mr-2 size-4" />}
          Invite
        </Button>
      </form>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {created && (
        <div className="mb-4 grid gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/5 p-3">
          <div className="text-sm">
            Invitation for <span className="font-medium">{created.invitation.email}</span>.{" "}
            {created.email_sent ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <Mail className="size-3.5" /> Email sent.
              </span>
            ) : created.email_error ? (
              <span className="text-amber-400">The email couldn't be sent ({created.email_error}); share the link yourself.</span>
            ) : (
              "Share this link with them; it is shown only now."
            )}
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs">{created.url}</code>
            <CopyButton text={created.url} label="Copy link" />
          </div>
        </div>
      )}
      {invitations.data && invitations.data.items.length > 0 && (
        <div className="divide-y rounded-md border">
          {invitations.data.items.map((inv) => (
            <div key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{inv.email}</div>
                <div className="text-xs text-muted-foreground">
                  {inv.role} · invited {formatAgo(inv.created_at)}
                  {inv.invited_by ? ` by ${inv.invited_by}` : ""} · expires {formatDate(inv.expires_at)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void revokeInvitation(workspace, inv.id).then(() => refreshWorkspace(workspace))}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
