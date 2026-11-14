import { useLocation } from "react-router";

import { QuotaNotice } from "@/components/usage/usage-parts";
import { useUsage } from "@/lib/api/hooks";
import { parseScope, usageLink } from "@/lib/links/links";

/**
 * App-wide notice at 80% and 100% of the current workspace's blocking monthly quota. Not on the usage page,
 * which shows its own.
 */
export function UsageBanner() {
  const { pathname } = useLocation();
  const workspace = parseScope(pathname)?.workspace ?? null;
  const { data } = useUsage(workspace);
  if (!workspace || !data || pathname === usageLink(workspace)) return null;
  return <QuotaNotice usage={data} link={usageLink(workspace)} />;
}
