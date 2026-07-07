import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LoginPage } from "../auth/LoginPage";
import { useAuth } from "../auth/useAuth";

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, isLoading } = useAuth();

  if (isLoading) return null;
  if (!user) return <LoginPage />;
  if (user.role !== "admin") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p role="alert" className="text-sm text-danger">
          {t("admin.forbidden")}
        </p>
        <Link to="/" className="text-sm text-accent underline">
          {t("admin.back")}
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
