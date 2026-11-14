/**
 * `ivy_session=1` is a routing hint for the CDN (signed-in visitors at `/` go to the app, others to the
 * website). It carries no token and grants nothing. It lasts 30 days, a common refresh-token lifetime, so it
 * lapses about when the session can no longer be renewed.
 */
export const MARKER_COOKIE = "ivy_session";
const MAX_AGE_S = 30 * 24 * 60 * 60;

export function markerCookie(signedIn: boolean, secure: boolean): string {
  return [
    `${MARKER_COOKIE}=${signedIn ? "1" : ""}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${signedIn ? MAX_AGE_S : 0}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function setMarkerCookie(signedIn: boolean) {
  document.cookie = markerCookie(signedIn, location.protocol === "https:");
}
