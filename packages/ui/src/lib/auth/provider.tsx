import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "oidc-client-ts";
import { setAuthHooks } from "@/lib/api/client";
import { useConfig } from "@/lib/api/hooks";
import { type AuthClient, createAuthClient } from "./client";
import { currentPath, loginPath } from "./return-to";

export type AuthStatus = "loading" | "disabled" | "signed-out" | "signed-in";

export interface SignedInUser {
  sub: string;
  email?: string;
  name?: string;
}

interface AuthState {
  status: AuthStatus;
  user: SignedInUser | null;
  client: AuthClient | null;
}

const AuthContext = createContext<AuthState>({ status: "loading", user: null, client: null });

/** Signed in while the access token is valid or can be renewed with a refresh token. */
const toUser = (user: User | null): SignedInUser | null =>
  user && (!user.expired || user.refresh_token)
    ? { sub: user.profile.sub, email: user.profile.email, name: user.profile.name }
    : null;

/**
 * Reads the auth settings from `GET /api/config` at runtime and, when OIDC is on, keeps track of the
 * session and attaches tokens to API calls. Without OIDC everything stays as it was (status `disabled`).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: config, error } = useConfig();
  const settings = config?.auth.enabled ? config.auth : null;
  const client = useMemo(() => (settings ? createAuthClient(settings) : null), [settings]);
  const [user, setUser] = useState<SignedInUser | null | undefined>(undefined);

  useEffect(() => {
    if (!client) return;
    setAuthHooks({
      getAccessToken: client.getAccessToken,
      onUnauthorized: () => {
        void client.forget().then(() => {
          if (!location.pathname.startsWith("/login")) location.assign(loginPath(currentPath(location)));
        });
      },
    });
    const update = (next: User | null) => setUser(toUser(next));
    void client.getUser().then(update);
    const onLoaded = (next: User) => update(next);
    const onUnloaded = () => update(null);
    client.manager.events.addUserLoaded(onLoaded);
    client.manager.events.addUserUnloaded(onUnloaded);
    return () => {
      setAuthHooks(undefined);
      client.manager.events.removeUserLoaded(onLoaded);
      client.manager.events.removeUserUnloaded(onUnloaded);
    };
  }, [client]);

  const status: AuthStatus =
    !config && !error
      ? "loading"
      : !client
        ? "disabled"
        : user === undefined
          ? "loading"
          : user
            ? "signed-in"
            : "signed-out";

  return <AuthContext.Provider value={{ status, user: user ?? null, client }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
