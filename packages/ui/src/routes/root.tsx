import { Outlet, useMatch } from "react-router";

import { AuthBanner } from "@/components/layout/auth-banner";
import { Menu } from "@/components/layout/menu";
import { UsageBanner } from "@/components/layout/usage-banner";
import { cn } from "@/lib/utils/cn";
import { RequireAuth } from "@/routes/auth/pages";

export default function Root() {
  const isTracePage = !!useMatch("/traces/:traceId");

  return (
    <RequireAuth>
      <div className={cn("flex min-h-screen flex-col", isTracePage && "md:h-screen")}>
        <AuthBanner />
        <UsageBanner />
        <Menu />
        {isTracePage ? (
          <Outlet />
        ) : (
          <main className="mx-auto w-full max-w-screen-2xl p-6 md:p-8 md:pt-6">
            <Outlet />
          </main>
        )}
      </div>
    </RequireAuth>
  );
}
