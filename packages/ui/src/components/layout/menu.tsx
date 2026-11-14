import { Link } from "react-router";

import { MenuLink } from "@/components/layout/menu-link";
import { ScopeSwitcher } from "@/components/layout/scope-switcher";
import { SearchMenu } from "@/components/layout/search-menu";
import { TimeRangePicker } from "@/components/layout/time-range";
import { UserMenu } from "@/components/layout/user-menu";
import { ALL_PROJECTS, pageLink, readLastScope, settingsLink } from "@/lib/links/links";
import { useRouteScope } from "@/lib/links/use-scope";

export function Menu() {
  const route = useRouteScope();
  const workspace = route?.workspace;
  // On settings pages, the project links go back to the last-used project of the workspace.
  const last = readLastScope();
  const project = route?.project ?? (last?.workspace === workspace ? last?.project : undefined) ?? ALL_PROJECTS;
  const link = (page: "functions" | "invocations" | "errors") => (workspace ? pageLink({ workspace, project }, page) : `/${page}`);

  return (
    <header className="border-b">
      <div className="flex h-16 items-center gap-4 px-4">
        <nav className="flex min-w-0 items-center gap-4 lg:gap-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link to={workspace ? `/w/${workspace}` : "/"} className="mr-1 flex shrink-0 items-center gap-2 font-semibold" aria-label="Ivy">
              <svg className="ml-1 size-6" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path
                  fill="#4ade80"
                  d="M16 2.5Q19.6 6 20.3 10.3Q25 9.4 29.5 11.6Q28.4 18.8 21.4 23.4Q18.8 25.2 16 24Q13.2 25.2 10.6 23.4Q3.6 18.8 2.5 11.6Q7 9.4 11.7 10.3Q12.4 6 16 2.5Z"
                />
                <path className="stroke-background" strokeWidth="1.5" strokeLinecap="round" d="M16 21.5V8M16 17l7.5-4.2M16 17l-7.5-4.2" />
                <path stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" d="M16 23.5c.3 2.2-.2 4-1.2 5.8" />
              </svg>
            </Link>
            {workspace && <ScopeSwitcher workspace={workspace} project={project} />}
          </div>
          <MenuLink to={link("functions")}>Functions</MenuLink>
          <MenuLink to={link("invocations")}>Invocations</MenuLink>
          <MenuLink to={link("errors")}>Errors</MenuLink>
          <MenuLink to={workspace ? settingsLink(workspace) : "/settings"} match={workspace ? `/w/${workspace}/settings` : "/settings"}>
            Settings
          </MenuLink>
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
