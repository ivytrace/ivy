import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";

import "./index.css";

import Root from "@/routes/root";
import Functions from "@/routes/functions/page";
import Invocations from "@/routes/invocations/page";
import Errors from "@/routes/errors/page";
import NotFound from "@/routes/not-found";
import { TimeRangeProvider } from "@/components/layout/time-range";
import { TooltipProvider } from "@/components/ui/tooltip";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
      { index: true, element: <Navigate to="/functions" replace /> },
      { path: "functions", element: <Functions /> },
      { path: "invocations", element: <Invocations /> },
      {
        path: "traces/:traceId",
        lazy: async () => ({ Component: (await import("@/routes/traces/page")).default }),
      },
      { path: "errors", element: <Errors /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TimeRangeProvider>
      <TooltipProvider delayDuration={100}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </TimeRangeProvider>
  </StrictMode>,
);
