import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { Bell, BellRing, Cloud, FolderKanban, Gauge, Settings2, Users } from "lucide-react";

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
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  // On narrow screens the sections are a scrolling row: keep the current one in view.
  const newFunctions = accounts.data?.items.reduce((n, a) => n + (a.counts.new ?? 0), 0) ?? 0;
  useEffect(() => {
    const el = nav.current;
    const active = el?.querySelector<HTMLElement>("[aria-current=page]");
    if (el && active && el.scrollWidth > el.clientWidth) active.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname, multi, newFunctions]);

  const sections: { section: SettingsSection; label: string; icon: typeof Cloud; badge?: number }[] = [
    { section: "general", label: "General", icon: Settings2 },
    ...(multi ? [{ section: "members" as const, label: "Members", icon: Users }] : []),
    { section: "projects", label: "Projects", icon: FolderKanban },
    { section: "aws", label: "AWS accounts", icon: Cloud, badge: newFunctions },
    { section: "usage", label: "Usage", icon: Gauge },
    { section: "alerts", label: "Alerts", icon: BellRing },
    { section: "notifications", label: "Notifications", icon: Bell },
  ];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[12rem_1fr] md:gap-8">
      <aside className="min-w-0">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mb-4 truncate text-sm text-muted-foreground">{info.data?.name ?? workspace}</p>
        <nav ref={nav} className="-mx-4 flex after:w-3 after:shrink-0 after:content-[''] md:after:hidden gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:mx-0 md:flex-col md:overflow-visible md:px-0">
          {sections.map(({ section, label, icon: Icon, badge }) => (
            <NavLink
              key={section}
              to={settingsLink(workspace, section)}
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent max-md:min-h-10",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground",
                )
              }
            >
              <Icon className="size-4 shrink-0" />
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
