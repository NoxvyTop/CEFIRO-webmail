import "./app/ui/themeInit";
import "@fontsource-variable/space-grotesk";
import "./index.css";
import "./app/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { routes } from "./app/routes";
import { registerPushServiceWorker } from "./features/notifications/push";

const client = new QueryClient();
const router = createBrowserRouter(routes);

// #294 (delivery slice): register the Web Push service worker at boot (idempotent
// and failure-tolerant). This only installs the notification receiver — it
// requests no permission and creates no subscription; that happens only on the
// explicit opt-in in Settings.
void registerPushServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* GH #345: last-resort boundary for anything that throws OUTSIDE the
        router's own tree — routes.tsx's `errorElement` (RouteError) only
        catches errors thrown while a matched route renders. */}
    <AppErrorBoundary>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
