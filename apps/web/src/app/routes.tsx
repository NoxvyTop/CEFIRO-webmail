import { lazy, Suspense } from "react";
import type { RouteObject } from "react-router";
import { Navigate } from "react-router";
import { RequireAuth } from "../features/auth/RequireAuth";
import { RequireAdmin } from "../features/admin/RequireAdmin";
import { MailPage } from "../features/mailbox/MailPage";
import { CefiroLoader } from "./ui/CefiroLoader";
import { App } from "./App";

// The admin, settings and setup screens are rarely the first thing a user
// lands on, so they're split into their own chunks (React.lazy) instead of
// weighing down the initial mail bundle. AdminPage and SettingsPage render
// inside App's <Outlet>, which already provides a Suspense boundary; SetupPage
// is a top-level route, so it gets its own fallback below. MailPage stays eager
// — it IS the initial view.
const AdminPage = lazy(() =>
  import("../features/admin/AdminPage").then((module) => ({ default: module.AdminPage })),
);
const SettingsPage = lazy(() =>
  import("../features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);
// GH #13/#50 (G-4): the "Buzones compartidos" page, reached from the left
// sidebar. Split off the initial mail bundle for the same reason as Settings —
// most sessions never open it. It renders inside App's <Outlet> Suspense.
const SharedMailboxesPage = lazy(() =>
  import("../features/mailbox/SharedMailboxesPage").then((module) => ({
    default: module.SharedMailboxesPage,
  })),
);
const SetupPage = lazy(() =>
  import("../features/setup/SetupPage").then((module) => ({ default: module.SetupPage })),
);

const routeFallback = (
  <div className="flex min-h-screen items-center justify-center">
    <CefiroLoader label />
  </div>
);

export const routes: RouteObject[] = [
  {
    element: (
      <RequireAuth>
        <App />
      </RequireAuth>
    ),
    children: [
      { path: "/", element: <MailPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/shared", element: <SharedMailboxesPage /> },
      {
        path: "/admin",
        element: (
          <RequireAdmin>
            <AdminPage />
          </RequireAdmin>
        ),
      },
    ],
  },
  {
    path: "/setup",
    element: (
      <Suspense fallback={routeFallback}>
        <SetupPage />
      </Suspense>
    ),
  },
  { path: "*", element: <Navigate to="/" replace /> },
];
