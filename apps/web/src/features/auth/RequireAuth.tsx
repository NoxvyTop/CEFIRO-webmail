import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../app/i18n";
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

  // #348: i18n.ts always initialized in "es" and nothing ever applied the
  // session user's own `locale`, so a user with a different preference still
  // got a Spanish UI. This is the one gate every authenticated screen passes
  // through, so it is the single place to sync the active language (and the
  // document's lang attribute, for screen readers and browser features like
  // spellcheck) once the session resolves.
  useEffect(() => {
    if (!user) return;
    if (i18n.language !== user.locale) {
      void i18n.changeLanguage(user.locale);
    }
    document.documentElement.lang = user.locale;
  }, [user]);

  if (isLoading) return null;
  if (isError) return <ServiceUnavailable onRetry={() => void refetch()} />;
  if (!user) return <LoginPage />;
  return <>{children}</>;
}
