import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authModeSchema, type AuthMode } from "@webmail/shared";
import { bootstrapLogin } from "./useAuth";
import { CefiroLogo } from "../../app/ui/CefiroLogo";

const KNOWN_ERRORS = new Set(["state", "unknown_user", "oidc"]);

async function fetchMode(): Promise<AuthMode> {
  const res = await fetch("/api/auth/mode");
  return authModeSchema.parse(await res.json());
}

export function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const error = params.get("auth_error");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: mode } = useQuery({ queryKey: ["auth", "mode"], queryFn: fetchMode });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapError, setBootstrapError] = useState(false);

  async function handleBootstrapSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await bootstrapLogin(email, password);
    if (ok) {
      setBootstrapError(false);
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      navigate("/");
    } else {
      setBootstrapError(true);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-4">
      <div className="flex flex-col items-center gap-3">
        <CefiroLogo size={72} />
        <h1 className="text-[19px] font-bold tracking-[0.32em] text-ink">CÉFIRO</h1>
        <p className="text-sm text-muted">{t("auth.subtitle")}</p>
      </div>
      {error && KNOWN_ERRORS.has(error) && (
        <p className="text-sm text-danger">{t(`auth.errors.${error}`)}</p>
      )}
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-2xl border border-line bg-panel p-7 shadow-card">
        {mode?.bootstrapMode !== true && (
          <a
            href="/api/auth/login"
            className="flex h-[46px] items-center justify-center gap-2 rounded-[11px] bg-accent px-4 font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            {t("auth.signIn")}
          </a>
        )}
        {mode?.bootstrapMode === true && (
          <>
            <h2 className="text-center text-sm font-semibold text-ink">
              {t("auth.bootstrap.title")}
            </h2>
            <form
              onSubmit={handleBootstrapSubmit}
              aria-label={t("auth.bootstrap.title")}
              className="flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor="bootstrap-email" className="text-muted">
                  {t("auth.bootstrap.email")}
                </label>
                <input
                  id="bootstrap-email"
                  type="text"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-11 rounded-[10px] border border-line bg-soft px-3 text-ink outline-none focus:border-accent"
                />
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor="bootstrap-password" className="text-muted">
                  {t("auth.bootstrap.password")}
                </label>
                <input
                  id="bootstrap-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-11 rounded-[10px] border border-line bg-soft px-3 text-ink outline-none focus:border-accent"
                />
              </div>
              <button
                type="submit"
                className="h-11 rounded-[11px] border border-line text-ink transition hover:border-accent"
              >
                {t("auth.bootstrap.submit")}
              </button>
              {bootstrapError && (
                <p className="text-sm text-danger">{t("auth.bootstrap.error")}</p>
              )}
              <p className="text-xs text-muted">{t("auth.bootstrap.hint")}</p>
            </form>
          </>
        )}
      </div>
      <p className="text-[11.5px] tracking-[0.14em] text-muted">
        <span className="font-bold text-accent">CÉFIRO</span> · {t("app.tagline")}
      </p>
    </main>
  );
}
