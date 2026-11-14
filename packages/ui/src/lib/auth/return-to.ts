export const AUTH_PATHS = ["/login", "/logout", "/auth/callback"];

/**
 * A path on this origin to continue on after signing in. Anything else (absolute or protocol-relative
 * URLs, backslash tricks, the auth routes themselves) falls back to `/`, so a crafted link can't send
 * people elsewhere or into a loop.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !/^\/(?![/\\])/.test(value) || /[\u0000-\u001f]/.test(value)) return "/";
  const pathname = value.split(/[?#]/)[0].replace(/\/+$/, "");
  return AUTH_PATHS.includes(pathname) ? "/" : value;
}

/** The sign-in route that comes back to `returnTo`. */
export function loginPath(returnTo: string): string {
  const target = safeReturnTo(returnTo);
  return target === "/" ? "/login" : `/login?${new URLSearchParams({ returnTo: target })}`;
}

export const currentPath = (location: { pathname: string; search: string; hash: string }) =>
  `${location.pathname}${location.search}${location.hash}`;
