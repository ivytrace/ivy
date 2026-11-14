import { Link } from "react-router";

import { MenuLink } from "@/components/layout/menu-link";
import { SearchMenu } from "@/components/layout/search-menu";
import { TimeRangePicker } from "@/components/layout/time-range";

export const Menu = () => (
  <header className="border-b">
    <div className="flex h-16 items-center gap-4 px-4">
      <nav className="flex items-center gap-4 lg:gap-6">
        <Link to="/" className="mr-1 flex items-center gap-2 font-semibold" aria-label="Ivy Trace">
          <svg className="ml-1 size-6" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
            <g stroke="currentColor" strokeWidth="5" fill="none">
              <polyline points="8.57 37.77 24 24 39.72 37.77" />
              <circle cx="24" cy="24" r="21" />
            </g>
          </svg>
          <span className="hidden sm:inline">Ivy Trace</span>
        </Link>
        <MenuLink to="/functions">Functions</MenuLink>
        <MenuLink to="/invocations">Invocations</MenuLink>
        <MenuLink to="/errors">Errors</MenuLink>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <TimeRangePicker />
        <SearchMenu />
      </div>
    </div>
  </header>
);
