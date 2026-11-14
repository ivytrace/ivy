import { NavLink, Outlet } from "react-router";
import { Cloud, FolderKanban, Gauge, Settings2, Users } from "lucide-react";

import { NewBadge } from "@/components/aws/account-parts";
import { useAwsAccounts, useMultiWorkspace, useWorkspaceInfo } from "@/lib/api/hooks";
import { settingsLink, type SettingsSection } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";
import { cn } from "@/lib/utils/cn";

export default function SettingsLayout() {
  const workspace = useWorkspace();
  const multi = useMultiWorkspace();
  const info = useWorkspaceInfo(workspace);
  const accounts = useAwsAccounts();
  const newFunctions = accounts.data?.items.reduce((n, a) => n + (a.counts.new ?? 0), 0) ?? 0;

  const sections: { section: SettingsSection; label: string; icon: typeof Cloud; badge?: number }[] = [
    { section: "general", label: "General", icon: Settings2 },
    ...(multi ? [{ section: "members" as const, label: "Members", icon: Users }] : []),
    { section: "projects", label: "Projects", icon: FolderKanban },
    { section: "aws", label: "AWS accounts", icon: Cloud, badge: newFunctions },
    { section: "usage", label: "Usage", icon: Gauge },
  ];

  return (
    <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
      <aside>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mb-4 truncate text-sm text-muted-foreground">{info.data?.name ?? workspace}</p>
        <nav className="flex flex-wrap gap-1 md:flex-col">
          {sections.map(({ section, label, icon: Icon, badge }) => (
            <NavLink
              key={section}
              to={settingsLink(workspace, section)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground",
                )
              }
            >
              <Icon className="size-4" />
              <span className="flex-1">{label}</span>
              {badge ? <NewBadge count={badge} /> : null}
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
