import { type User, UserManager, WebStorageStateStore } from "oidc-client-ts";
import type { AuthSettings } from "@/lib/api/types";
import { setMarkerCookie } from "./marker-cookie";
import { safeReturnTo } from "./return-to";

export interface SignInOptions {
  returnTo?: string;
  loginHint?: string;
  /** `signup` asks for the provider's sign-up screen where it has one; other providers ignore it. */
  screen?: string;
}

interface State {
  returnTo: string;
}

/**
 * Wraps oidc-client-ts (authorization code + PKCE, refresh tokens with `offline_access`). The session
 * lives in localStorage so it's shared by tabs and survives reloads.
 */
export function createAuthClient(settings: AuthSettings) {
  const origin = location.origin;
  const manager = new UserManager({
    authority: settings.issuer,
    client_id: settings.clientId,
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: "code",
    scope: settings.scopes,
    // RFC 8707 resource indicator (most providers); signIn also sends Auth0's `audience`
    resource: settings.audience,
    userStore: new WebStorageStateStore({ store: localStorage }),
    automaticSilentRenew: true,
  });

  manager.events.addUserSignedOut(() => void manager.removeUser());
  manager.events.addUserUnloaded(() => setMarkerCookie(false));

  let renewing: Promise<User | null> | undefined;
  const renew = () =>
    (renewing ??= manager
      .signinSilent()
      .catch(() => manager.removeUser().then(() => null))
      .finally(() => (renewing = undefined)));

  const callbacks = new Map<string, Promise<string>>();

  return {
    manager,

    getUser: () => manager.getUser(),

    /** A valid access token, renewed with the refresh token first when it has expired; null when signed out. */
    async getAccessToken(): Promise<string | null> {
      let user = await manager.getUser();
      if (user?.expired) user = user.refresh_token ? await renew() : null;
      return user?.access_token ?? null;
    },

    signIn({ returnTo, loginHint, screen }: SignInOptions = {}) {
      const state: State = { returnTo: safeReturnTo(returnTo ?? "/") };
      return manager.signinRedirect({
        state,
        login_hint: loginHint || undefined,
        extraQueryParams: { audience: settings.audience, ...(screen && { screen }) },
      });
    },

    /** On `/auth/callback`: swaps the code for tokens and resolves to the path to continue on. */
    handleCallback(url = location.href): Promise<string> {
      let done = callbacks.get(url);
      if (!done) {
        done = manager.signinRedirectCallback(url).then((user) => {
          setMarkerCookie(true);
          return safeReturnTo((user.state as State | undefined)?.returnTo);
        });
        callbacks.set(url, done);
      }
      return done;
    },

    /** Forgets the session here (on a 401, for instance) without leaving the page. */
    async forget() {
      await manager.removeUser();
      setMarkerCookie(false);
    },

    /** Signs out locally and at the provider (end_session), which then sends the browser to `/`. */
    async signOut() {
      const user = await manager.getUser();
      setMarkerCookie(false);
      await manager.removeUser();
      try {
        await manager.signoutRedirect({ id_token_hint: user?.id_token, post_logout_redirect_uri: `${origin}/` });
      } catch {
        // The provider has no end_session_endpoint: the local session is gone, which is all we can do
        location.assign("/");
      }
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
