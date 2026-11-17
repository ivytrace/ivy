import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { Check, ChevronsUpDown, Layers, LogOut, MenuIcon, Settings } from "lucide-react";

import { Logo } from "@/components/layout/logo";
import { SearchMenu } from "@/components/layout/search-menu";
import { PRESETS, rangeLabel, useTimeRange } from "@/components/layout/time-range";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useProjects, useWorkspaces } from "@/lib/api/hooks";
import { useAuth } from "@/lib/auth/provider";
import { ALL_PROJECTS, settingsLink, switchProjectLink, type Scope } from "@/lib/links/links";
import { cn } from "@/lib/utils/cn";

const itemClass = "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t px-3 py-3 first:border-t-0">
      <h2 className="px-3 pb-1 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function ListLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link to={to} aria-current={active ? "page" : undefined} className={cn(itemClass, active ? "bg-accent font-medium text-foreground" : "text-muted-foreground")}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check className="size-4 shrink-0" />}
    </Link>
  );
}

/** Workspaces and projects as lists (All projects first). */
function ScopeLists({ scope }: { scope: Scope }) {
  const { pathname, search } = useLocation();
  const workspaces = useWorkspaces();
  const projects = useProjects(scope.workspace);
  const onSettings = pathname.startsWith(`/w/${scope.workspace}/settings`);
  const isActive = (project: string) => !onSettings && scope.project === project;
  return (
    <>
      {(workspaces.data?.items.length ?? 0) > 1 && (
        <Section title="Workspace">
          {workspaces.data?.items.map((w) => (
            <ListLink key={w.id} to={`/w/${w.slug}`} active={w.slug === scope.workspace}>
              {w.name}
            </ListLink>
          ))}
        </Section>
      )}
      <Section title="Project">
        <ListLink to={switchProjectLink(pathname, { workspace: scope.workspace, project: ALL_PROJECTS }, search)} active={isActive(ALL_PROJECTS)}>
          <span className="inline-flex items-center gap-2">
            <Layers className="size-4" /> All projects
          </span>
        </ListLink>
        <div className="mx-3 my-1 border-t" />
        {projects.data?.items.map((p) => (
          <ListLink key={p.id} to={switchProjectLink(pathname, { workspace: scope.workspace, project: p.slug }, search)} active={isActive(p.slug)}>
            {p.name}
          </ListLink>
        ))}
        <Link to={settingsLink(scope.workspace, "projects")} className={cn(itemClass, "text-muted-foreground")}>
          <Settings className="size-4" /> Manage projects
        </Link>
      </Section>
    </>
  );
}

function TimeRangeList() {
  const { range, setRange } = useTimeRange();
  const custom = !("since" in range);
  return (
    <Section title="Time range">
      {PRESETS.map((p) => {
        const active = "since" in range && range.since === p.since;
        return (
          <button
            key={p.since}
            type="button"
            aria-pressed={active}
            onClick={() => setRange({ since: p.since })}
            className={cn(itemClass, active ? "bg-accent font-medium text-foreground" : "text-muted-foreground")}
          >
            <span className="flex-1">{p.label}</span>
            {active && <Check className="size-4" />}
          </button>
        );
      })}
      {custom && (
        <div className={cn(itemClass, "bg-accent font-medium hover:bg-accent")}>
          <span className="flex-1">{rangeLabel(range)}</span>
          <Check className="size-4" />
        </div>
      )}
    </Section>
  );
}

function Account() {
  const { status, user } = useAuth();
  if (status !== "signed-in" || !user) return null;
  const label = user.email ?? user.name ?? user.sub;
  return (
    <Section title="Account">
      <div className="truncate px-3 py-2 text-sm" title={label}>
        {label}
      </div>
      <Link to="/logout" className={cn(itemClass, "text-muted-foreground")}>
        <LogOut className="size-4" /> Sign out
      </Link>
    </Section>
  );
}

/** Below `md`: logo, the project as a switcher trigger, search, and a menu button; both open a sheet. */
export function MobileNav({ scope, projectLabel, links }: { scope: Scope | null; projectLabel: string; links: { to: string; label: string; match?: string }[] }) {
  const location = useLocation();
  const [open, setOpen] = useState<"menu" | "scope" | null>(null);

  useEffect(() => setOpen(null), [location.pathname]);

  return (
    <div className="flex h-14 items-center gap-1 px-2 md:hidden">
      <Link to={scope ? `/w/${scope.workspace}` : "/"} className="flex size-10 shrink-0 items-center justify-center" aria-label="Ivy">
        <Logo />
      </Link>
      {scope && (
        <button
          type="button"
          onClick={() => setOpen("scope")}
          className="flex h-10 min-w-0 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-accent"
          aria-label="Switch project"
        >
          <span className="truncate">{projectLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SearchMenu />
        <Button variant="ghost" size="icon" className="size-10" aria-label="Menu" onClick={() => setOpen("menu")}>
          <MenuIcon className="size-5" />
        </Button>
      </div>

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent>
          <div className="flex h-14 shrink-0 items-center border-b px-6 pr-14">
            <SheetTitle className="text-base font-semibold">{open === "scope" ? "Switch project" : "Menu"}</SheetTitle>
            <SheetDescription className="sr-only">{open === "scope" ? "Workspaces and projects" : "Pages, project, time range and account"}</SheetDescription>
          </div>
          <div className="flex-1 overflow-y-auto pb-6">
            {open === "menu" && (
              <Section title="Pages">
                {links.map((l) => (
                  <NavLink
                    key={l.label}
                    to={l.to}
                    className={({ isActive }) => {
                      const active = l.match ? location.pathname.startsWith(l.match) : isActive;
                      return cn(itemClass, active ? "bg-accent font-medium text-foreground" : "text-muted-foreground");
                    }}
                  >
                    {l.label}
                  </NavLink>
                ))}
              </Section>
            )}
            {scope && <ScopeLists scope={scope} />}
            {open === "menu" && <TimeRangeList />}
            {open === "menu" && <Account />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
