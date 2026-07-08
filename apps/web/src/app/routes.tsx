import type { RouteObject } from "react-router-dom";
import { Navigate } from "react-router-dom";
import { RequireAuth } from "../features/auth/RequireAuth";
import { RequireAdmin } from "../features/admin/RequireAdmin";
import { AdminPage } from "../features/admin/AdminPage";
import { SetupPage } from "../features/setup/SetupPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { MailPage } from "../features/mailbox/MailPage";
import { App } from "./App";

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
  { path: "/setup", element: <SetupPage /> },
  { path: "*", element: <Navigate to="/" replace /> },
];
