import { Link } from "react-router";

import { Logo } from "@/components/layout/logo";
import { MenuLink } from "@/components/layout/menu-link";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ScopeSwitcher } from "@/components/layout/scope-switcher";
import { SearchMenu } from "@/components/layout/search-menu";
import { TimeRangePicker } from "@/components/layout/time-range";
import { UserMenu } from "@/components/layout/user-menu";
import { useProjects } from "@/lib/api/hooks";
import { ALL_PROJECTS, pageLink, settingsLink } from "@/lib/links/links";
import { useNavScope } from "@/lib/links/use-scope";
import { useIsDesktop } from "@/lib/utils/media";

export function Menu() {
  // On settings pages, the project links go back to the last-used project of the workspace.
  const scope = useNavScope();
  const desktop = useIsDesktop();
  const projects = useProjects(desktop ? undefined : scope?.workspace);
  const workspace = scope?.workspace;
  const project = scope?.project ?? ALL_PROJECTS;
  const link = (page: "functions" | "invocations" | "errors" | "query") => (scope ? pageLink(scope, page) : `/${page}`);
  const links = [
    { to: link("functions"), label: "Functions" },
    { to: link("invocations"), label: "Invocations" },
    { to: link("errors"), label: "Errors" },
    { to: link("query"), label: "Query" },
    { to: workspace ? settingsLink(workspace) : "/settings", label: "Settings", match: workspace ? `/w/${workspace}/settings` : "/settings" },
  ];

  if (!desktop) {
    const projectLabel = project === ALL_PROJECTS ? "All projects" : (projects.data?.items.find((p) => p.slug === project)?.name ?? project);
    return (
      <header className="border-b">
        <MobileNav scope={scope} projectLabel={projectLabel} links={links} />
      </header>
    );
  }

  return (
    <header className="border-b">
      <div className="flex h-16 items-center gap-4 px-4">
        <nav className="flex min-w-0 items-center gap-4 lg:gap-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link to={workspace ? `/w/${workspace}` : "/"} className="mr-1 flex shrink-0 items-center gap-2 font-semibold" aria-label="Ivy">
              <Logo className="ml-1" />
            </Link>
            {workspace && <ScopeSwitcher workspace={workspace} project={project} />}
          </div>
          {links.map((l) => (
            <MenuLink key={l.label} to={l.to} match={l.match}>
              {l.label}
            </MenuLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <TimeRangePicker />
          <SearchMenu />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
