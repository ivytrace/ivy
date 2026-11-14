import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AlertTriangle, Loader2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/components/workspaces/name-dialog";
import type { InvitationInfo } from "@/lib/api/types";
import { acceptInvitation, getInvitation, refreshWorkspace } from "@/lib/api/workspaces";
import { useAuth } from "@/lib/auth/provider";
import { rememberJoinedByInvite } from "@/lib/welcome/welcome";

/** `/invite/:token`: accept a workspace invitation (needs sign-in with the invited, verified email). */
export default function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getInvitation(token).then(setInfo, (err) => setError(errorMessage(err)));
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptInvitation(token);
      await refreshWorkspace();
      rememberJoinedByInvite(res.workspace.slug);
      navigate(`/w/${res.workspace.slug}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const signedInAs = user?.email ?? user?.name ?? user?.sub;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border p-6">
        <div className="mb-4 flex items-center gap-2 text-muted-foreground">
          <Users className="size-5" />
          <span className="text-sm">Workspace invitation</span>
        </div>
        {!info && !error ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading invitation…
          </div>
        ) : info ? (
          <>
            <h1 className="text-xl font-semibold">Join {info.workspace.name} on Ivy</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {info.invited_by ? `${info.invited_by} invited ` : "This invitation is for "}
              <span className="text-foreground">{info.email}</span>, as {info.role === "owner" ? "an owner" : "a member"}.
              {signedInAs ? ` You're signed in as ${signedInAs}.` : ""}
            </p>
            {info.status === "pending" ? (
              <Button className="mt-5 w-full" onClick={() => void accept()} disabled={busy}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Accept invitation
              </Button>
            ) : (
              <p className="mt-4 text-sm text-amber-400">
                This invitation is {info.status === "accepted" ? "already used" : info.status}. Ask an owner of {info.workspace.name} for a new one.
              </p>
            )}
          </>
        ) : null}
        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="mt-6 flex justify-between text-sm">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            Go to Ivy
          </Link>
          {signedInAs && (
            <Link to={`/logout`} className="text-muted-foreground hover:text-foreground">
              Sign in with another account
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
