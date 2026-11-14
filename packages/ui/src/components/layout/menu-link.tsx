import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "@/lib/utils/cn";

export const MenuLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      cn("text-sm font-medium transition-colors hover:text-foreground", !isActive && "text-muted-foreground")
    }
  >
    {children}
  </NavLink>
);
