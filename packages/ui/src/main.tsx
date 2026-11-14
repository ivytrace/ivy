import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";

import "./index.css";

import Root from "@/routes/root";
import Functions from "@/routes/functions/page";
import Invocations from "@/routes/invocations/page";
import Errors from "@/routes/errors/page";
import NotFound from "@/routes/not-found";
import SettingsLayout from "@/routes/settings/layout";
import GeneralSettings from "@/routes/settings/general";
import MembersSettings from "@/routes/settings/members";
import ProjectsSettings from "@/routes/settings/projects";
import AwsAccounts from "@/routes/settings/aws/page";
import AwsAccountPage from "@/routes/settings/aws/account";
import UsagePage from "@/routes/settings/usage/page";
import AlertsSettings from "@/routes/settings/alerts";
import DigestSettings from "@/routes/settings/digest";
import NotificationsSettings from "@/routes/settings/notifications";
import InvitePage from "@/routes/invite/page";
import WelcomePage from "@/routes/welcome/page";
import { LegacyRedirect, ProjectLayout, WorkspaceIndex } from "@/routes/scope/redirects";
import { TimeRangeProvider } from "@/components/layout/time-range";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth/provider";
import { CallbackPage, LoginPage, LogoutPage, RequireAuth } from "@/routes/auth/pages";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/auth/callback", element: <CallbackPage /> },
  { path: "/logout", element: <LogoutPage /> },
  {
    path: "/invite/:token",
    element: (
      <RequireAuth>
        <InvitePage />
      </RequireAuth>
    ),
  },
  {
    path: "/welcome/:step",
    element: (
      <RequireAuth>
        <WelcomePage />
      </RequireAuth>
    ),
  },
  {
    path: "/",
    element: <Root />,
    children: [
      // Paths from before workspaces and projects keep working.
      { index: true, element: <LegacyRedirect /> },
      { path: "functions", element: <LegacyRedirect /> },
      { path: "invocations", element: <LegacyRedirect /> },
      { path: "errors", element: <LegacyRedirect /> },
      { path: "traces/:traceId", element: <LegacyRedirect /> },
      { path: "settings", element: <LegacyRedirect /> },
      { path: "settings/aws", element: <LegacyRedirect /> },
      { path: "settings/aws/:id", element: <LegacyRedirect /> },
      { path: "settings/usage", element: <LegacyRedirect /> },
      {
        path: "w/:workspace",
        children: [
          { index: true, element: <WorkspaceIndex /> },
          {
            path: "settings",
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Navigate to="general" replace /> },
              { path: "general", element: <GeneralSettings /> },
              { path: "members", element: <MembersSettings /> },
              { path: "projects", element: <ProjectsSettings /> },
              { path: "aws", element: <AwsAccounts /> },
              { path: "aws/:id", element: <AwsAccountPage /> },
              { path: "usage", element: <UsagePage /> },
              { path: "alerts", element: <AlertsSettings /> },
              { path: "alerts/:project", element: <AlertsSettings /> },
              { path: "digest", element: <DigestSettings /> },
              { path: "notifications", element: <NotificationsSettings /> },
            ],
          },
          {
            path: ":project",
            element: <ProjectLayout />,
            children: [
              { index: true, element: <Navigate to="functions" replace /> },
              { path: "functions", element: <Functions /> },
              { path: "invocations", element: <Invocations /> },
              { path: "errors", element: <Errors /> },
              {
                path: "traces/:traceId",
                lazy: async () => ({ Component: (await import("@/routes/traces/page")).default }),
              },
            ],
          },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <TimeRangeProvider>
        <TooltipProvider delayDuration={100}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </TimeRangeProvider>
    </AuthProvider>
  </StrictMode>,
);
