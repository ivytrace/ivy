import { useMatch } from "react-router";

import { QuotaNotice } from "@/components/usage/usage-parts";
import { useUsage } from "@/lib/api/hooks";
import { USAGE_PATH } from "@/lib/links/links";

/** Dashboard-wide notice at 80% and 100% of a blocking monthly quota (the usage page shows its own). */
export function UsageBanner() {
  const { data } = useUsage();
  const onUsagePage = !!useMatch(USAGE_PATH);
  if (!data || onUsagePage) return null;
  return <QuotaNotice usage={data} compact />;
}
