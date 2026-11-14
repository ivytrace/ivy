import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/utils/cn";

/** A header link; `match` marks it active for every path under that prefix (default: `to`). */
export function MenuLink({ to, match, children }: { to: string; match?: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const active = match ? pathname.startsWith(match) : undefined;
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn("hidden text-sm font-medium transition-colors hover:text-foreground sm:inline", !(active ?? isActive) && "text-muted-foreground")
      }
    >
      {children}
    </NavLink>
  );
}
