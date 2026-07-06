import type { RouteObject } from "react-router-dom";
import { RequireAuth } from "../features/auth/RequireAuth";
import { SetupPage } from "../features/setup/SetupPage";
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
  { path: "/setup", element: <SetupPage /> },
];
