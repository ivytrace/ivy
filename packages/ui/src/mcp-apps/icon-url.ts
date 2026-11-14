import type { ServiceIcon } from "@ivy/spans";
import { large, mini } from "virtual:ivy-service-icons";

/**
 * Inlined service icons for the MCP Apps views (replaces `@/lib/spans/icon-url` in that build; see
 * mcp-apps/icons-plugin.ts). Views without graph nodes ship only the mini set.
 */
export function serviceIconUrl(icon: ServiceIcon, size: "mini" | "large"): string {
  const set = size === "large" && Object.keys(large).length ? large : mini;
  return set[icon] ?? set.external;
}
