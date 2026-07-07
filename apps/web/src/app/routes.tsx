import type { RouteObject } from "react-router-dom";
import { RequireAuth } from "../features/auth/RequireAuth";
import { RequireAdmin } from "../features/admin/RequireAdmin";
import { AdminPage } from "../features/admin/AdminPage";
import { SetupPage } from "../features/setup/SetupPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { App } from "./App";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: (
      <RequireAuth>
        <App />
      </RequireAuth>
    ),
  },
  {
    path: "/settings",
    element: (
      <RequireAuth>
        <SettingsPage />
      </RequireAuth>
    ),
  },
  {
    path: "/admin",
    element: (
      <RequireAdmin>
        <AdminPage />
      </RequireAdmin>
    ),
  },
  { path: "/setup", element: <SetupPage /> },
];
