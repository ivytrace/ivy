import { apiFetch, ApiError } from "./client";

export type BillingAction = "checkout" | "portal";

/**
 * Asks the billing service (`/api/config` → `billing.url`) for a Stripe Checkout or Customer Portal
 * session with the user's token, and returns where to send the browser.
 */
export async function billingSessionUrl(baseUrl: string, action: BillingAction, workspace: string): Promise<string> {
  const res = await apiFetch(`${baseUrl.replace(/\/$/, "")}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ workspace }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new ApiError(res.status, body.error ?? `Billing failed (${res.status})`);
  return body.url;
}
