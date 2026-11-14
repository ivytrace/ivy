import type { TimeRange } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type QueryParams = Record<string, string | number | null | undefined>;

export function buildUrl(path: string, params: QueryParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return `/api${path}${qs ? `?${qs}` : ""}`;
}

export function rangeParams(range: TimeRange): QueryParams {
  return "since" in range ? { since: range.since } : { from: range.from, to: range.to };
}

interface AuthHooks {
  getAccessToken: () => Promise<string | null>;
  onUnauthorized: () => void;
}

let auth: AuthHooks | undefined;

/** Set by the auth provider when OIDC is on: API calls then carry a bearer token. */
export function setAuthHooks(hooks: AuthHooks | undefined) {
  auth = hooks;
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth?.getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && auth) auth.onUnauthorized();
  return res;
}

/** Downloads a file from the API with the user's token (a plain link can't carry one). */
export async function downloadFile(url: string, filename: string) {
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(url, { ...init, headers: { accept: "application/json", ...init.headers } });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep status text
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export function sendJson<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
