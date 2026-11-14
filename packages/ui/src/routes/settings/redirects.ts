import { redirect, type RouteObject } from "react-router";

import { settingsLink } from "@/lib/links/links";

/** Settings pages that were merged into another one; their old URLs keep working. */
export const mergedSettingsRoutes: RouteObject[] = [
  { path: "digest", loader: ({ params }) => redirect(settingsLink(params.workspace!, "notifications")) },
];
