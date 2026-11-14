import { NavLink, Outlet } from "react-router";
import { Cloud } from "lucide-react";

import { AWS_ACCOUNTS_PATH } from "@/lib/links/links";
import { cn } from "@/lib/utils/cn";

const SECTIONS = [{ to: AWS_ACCOUNTS_PATH, label: "AWS accounts", icon: Cloud }];

export default function SettingsLayout() {
  return (
    <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
      <aside>
        <h1 className="mb-4 text-2xl font-bold">Settings</h1>
        <nav className="flex gap-1 md:flex-col">
          {SECTIONS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
