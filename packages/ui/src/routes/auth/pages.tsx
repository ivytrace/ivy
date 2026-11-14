import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/provider";
import { currentPath, loginPath, safeReturnTo } from "@/lib/auth/return-to";

function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">{children}</div>
  );
}

const Working = ({ label }: { label: string }) => (
  <AuthScreen>
    <Loader2 className="mr-2 size-4 animate-spin" />
    {label}
  </AuthScreen>
);

function Failed({ message, returnTo = "/" }: { message: string; returnTo?: string }) {
  return (
    <AuthScreen>
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertTriangle className="size-6 text-red-400" />
        <div>
          <div className="font-medium text-foreground">Signing in didn't work</div>
          <div className="mt-1">{message}</div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={loginPath(returnTo)}>Sign in again</Link>
        </Button>
      </div>
    </AuthScreen>
  );
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `/login?returnTo=&login_hint=&screen=signup`: starts sign-in at the provider. */
export function LoginPage() {
  const { status, client } = useAuth();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo") ?? "/");
  const started = useRef(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (status !== "signed-out" || !client || started.current) return;
    started.current = true;
    client
      .signIn({ returnTo, loginHint: params.get("login_hint") ?? undefined, screen: params.get("screen") ?? undefined })
      .catch(setError);
  }, [status, client, returnTo, params]);

  if (status === "disabled" || status === "signed-in") return <Navigate to={returnTo} replace />;
  if (error) return <Failed message={errorMessage(error)} returnTo={returnTo} />;
  return <Working label="Redirecting to sign in…" />;
}

/** `/auth/callback`: finishes sign-in and continues on the stored path. */
export function CallbackPage() {
  const { client, status } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (!client) return;
    client.handleCallback().then((path) => navigate(path, { replace: true }), setError);
  }, [client, navigate]);

  if (status === "disabled") return <Navigate to="/" replace />;
  if (error) return <Failed message={errorMessage(error)} />;
  return <Working label="Signing in…" />;
}

/** `/logout`: signs out here and at the provider, which sends the browser back to `/`. */
export function LogoutPage() {
  const { client, status } = useAuth();
  const started = useRef(false);

  useEffect(() => {
    if (!client || started.current) return;
    started.current = true;
    void client.signOut();
  }, [client]);

  if (status === "disabled") return <Navigate to="/" replace />;
  return <Working label="Signing out…" />;
}

/** Sends signed-out visitors to `/login?returnTo=<this page>`. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return null;
  if (status === "signed-out") return <Navigate to={loginPath(currentPath(location))} replace />;
  return children;
}
