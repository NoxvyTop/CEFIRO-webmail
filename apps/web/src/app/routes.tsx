import type { RouteObject } from "react-router-dom";
import { RequireAuth } from "../features/auth/RequireAuth";
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
];
