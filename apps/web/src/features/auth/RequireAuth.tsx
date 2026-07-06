import type { ReactNode } from "react";
import { LoginPage } from "./LoginPage";
import { useAuth } from "./useAuth";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) return <LoginPage />;
  return <>{children}</>;
}
