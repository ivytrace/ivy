import type { ServiceIcon } from "./services";

/**
 * URL of a service icon (`mini` 16 px for rows, `large` for graph nodes). The MCP Apps build swaps this
 * module for `src/mcp-apps/icon-url.ts`, which inlines the SVGs because views cannot load files.
 */
export function serviceIconUrl(icon: ServiceIcon, size: "mini" | "large"): string {
  return `/images/${size === "mini" ? "service-icons-mini" : "service-icons"}/${icon}.svg`;
}
