import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoginPage } from "./LoginPage";
import { useAuth } from "./useAuth";

// GH #341: a 502/503 from the proxy while the backend is down used to reach
// sessionUserSchema.parse and throw, which after RequireAuth's retries left
// `user` undefined — indistinguishable from "not signed in", so the login
// screen appeared and clicking "SSO" led to a 502 page. This distinguishes
// "the service could not be reached" (retry) from "no session" (log in).
function ServiceUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center text-muted">
      <p role="alert" className="text-[15px] font-semibold text-ink">
        {t("auth.serviceUnavailable.title")}
      </p>
      <p className="max-w-[320px] text-[13px] text-muted">
        {t("auth.serviceUnavailable.description")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 flex h-9 items-center justify-center rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
      >
        {t("auth.serviceUnavailable.retry")}
      </button>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading, isError, refetch } = useAuth();
  if (isLoading) return null;
  if (isError) return <ServiceUnavailable onRetry={() => void refetch()} />;
  if (!user) return <LoginPage />;
  return <>{children}</>;
}
