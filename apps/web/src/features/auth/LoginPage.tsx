import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authModeSchema, type AuthMode } from "@webmail/shared";
import { bootstrapLogin } from "./useAuth";
import { errorMessageKey } from "../../app/errorMessages";
import { CefiroLogo } from "../../app/ui/CefiroLogo";
import { MoonIcon, SunIcon } from "../../app/ui/icons";
import { useTheme } from "../../app/ui/useTheme";

const SSO_LOGIN_URL = "/api/auth/login";
// Purely a visual beat before the real redirect (spec: "~1.4s") — the actual
// navigation still happens via window.location, just delayed so the
// "Conectando…"/pulse state has time to be seen.
const SSO_REDIRECT_DELAY_MS = 1400;

async function fetchMode(): Promise<AuthMode> {
  const res = await fetch("/api/auth/mode");
  return authModeSchema.parse(await res.json());
}

// Whether the first-run setup wizard is still reachable (GH #287). The setup
// router closes for good once setup completes — an active admin exists and SSO
// is configured (GH #234) — and then answers 404, the same as a disabled setup
// (the way SetupPage reads it). We hold no setup token here, so an OPEN latch
// replies 401 rather than 200; only its openness matters, so any non-404 status
// means the wizard is still available and the operator should be pointed at it.
async function fetchSetupLatchOpen(): Promise<boolean> {
  const res = await fetch("/api/setup/status");
  return res.status !== 404;
}

// Bootstrap mode has no notion of an email address — the field is labeled
// "Usuario" and the server (bootstrapLoginSchema) only requires a non-empty
// string; it authenticates purely on the password. Email-format validation
// belongs to a future credentials-mode form, not to this one.
function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

interface BootstrapFieldErrors {
  email?: string;
  password?: string;
}

export function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const error = params.get("auth_error");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: mode } = useQuery({ queryKey: ["auth", "mode"], queryFn: fetchMode });
  // Only ask about the setup latch in bootstrap mode: outside it the wizard is
  // irrelevant, and querying an unauthenticated /api/setup/status would only add
  // a needless request (and a rejected-auth audit row) while the latch is open.
  const { data: setupLatchOpen } = useQuery({
    queryKey: ["setup", "latch"],
    queryFn: fetchSetupLatchOpen,
    enabled: mode?.bootstrapMode === true,
  });
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapError, setBootstrapError] = useState<
    "invalid" | "rate_limited" | "network" | null
  >(null);
  const [fieldErrors, setFieldErrors] = useState<BootstrapFieldErrors>({});
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [ssoConnecting, setSsoConnecting] = useState(false);

  function validateBootstrapFields(): boolean {
    const errors: BootstrapFieldErrors = {};
    if (!isNonEmpty(email)) errors.email = t("auth.bootstrap.errors.emptyUser");
    if (!password) errors.password = t("auth.bootstrap.errors.emptyPassword");
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleBootstrapSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bootstrapPending) return;
    if (!validateBootstrapFields()) return;
    setBootstrapPending(true);
    const result = await bootstrapLogin(email, password);
    if (result === "ok") {
      setBootstrapError(null);
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      // Leave the button disabled through the navigation — re-enabling it only
      // on failure keeps a second POST from firing during the redirect.
      navigate("/");
      return;
    }
    setBootstrapPending(false);
    setBootstrapError(
      result === "rate_limited" ? "rate_limited" : result === "network_error" ? "network" : "invalid",
    );
  }

  function handleSsoClick(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (ssoConnecting) return;
    setSsoConnecting(true);
    window.setTimeout(() => {
      window.location.href = SSO_LOGIN_URL;
    }, SSO_REDIRECT_DELAY_MS);
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={t(theme === "night" ? "app.themeLight" : "app.themeNight")}
        title={t(theme === "night" ? "app.themeLight" : "app.themeNight")}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition hover:bg-hover hover:text-ink"
      >
        {theme === "night" ? <SunIcon /> : <MoonIcon />}
      </button>
      <div className="flex flex-col items-center">
        <div className="mb-5">
          <CefiroLogo size={72} />
        </div>
        <h1 className="mb-1.5 text-[19px] font-bold tracking-[0.32em] text-ink">CÉFIRO</h1>
        <p className="mb-8 text-[13.5px] text-muted">{t("auth.subtitle")}</p>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">{t(errorMessageKey("auth", error))}</p>
      )}
      <div className="flex w-full max-w-[400px] flex-col rounded-2xl border border-line bg-panel p-7 shadow-card">
        {mode?.bootstrapMode !== true && (
          <>
            <a
              href={SSO_LOGIN_URL}
              onClick={handleSsoClick}
              aria-disabled={ssoConnecting}
              className="flex h-[46px] items-center justify-center gap-2.5 rounded-[11px] bg-accent px-4 text-[14.5px] font-bold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
                <rect x="4" y="10" width="16" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              {ssoConnecting
                ? t("auth.connecting")
                : t("auth.signIn", { provider: mode?.providerName ?? "SSO" })}
            </a>
            {ssoConnecting && (
              <p className="mt-3 animate-pulse text-center text-[12.5px] text-accent-text">
                {t("auth.redirecting")}
              </p>
            )}
          </>
        )}
        {mode?.bootstrapMode === true && (
          <>
            {/* GH #287: while the setup latch is still open, first-run setup is
                the intended path — surface it as the primary CTA, and keep the
                break-glass emergency login below as the fallback. */}
            {setupLatchOpen === true && (
              <Link
                to="/setup"
                className="mb-5 flex h-[46px] items-center justify-center gap-2.5 rounded-[11px] bg-accent px-4 text-[14.5px] font-bold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
              >
                {t("auth.bootstrap.setupCta")}
              </Link>
            )}
            <h2 className="text-center text-sm font-semibold text-ink">
              {t("auth.bootstrap.title")}
            </h2>
            <div className="my-[18px] flex items-center gap-3">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[11.5px] tracking-[0.05em] text-muted">{t("auth.bootstrap.hint")}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <form
              onSubmit={handleBootstrapSubmit}
              aria-label={t("auth.bootstrap.title")}
              className="flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bootstrap-email" className="text-[12.5px] font-semibold text-muted">
                  {t("auth.bootstrap.email")}
                </label>
                <input
                  id="bootstrap-email"
                  type="text"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setFieldErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  aria-invalid={fieldErrors.email ? true : undefined}
                  aria-describedby={fieldErrors.email ? "bootstrap-email-error" : undefined}
                  className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
                />
                {fieldErrors.email && (
                  <p id="bootstrap-email-error" role="alert" className="text-[12.5px] text-danger">
                    {fieldErrors.email}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bootstrap-password" className="text-[12.5px] font-semibold text-muted">
                  {t("auth.bootstrap.password")}
                </label>
                <input
                  id="bootstrap-password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFieldErrors((prev) => ({ ...prev, password: undefined }));
                  }}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={fieldErrors.password ? "bootstrap-password-error" : undefined}
                  className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
                />
                {fieldErrors.password && (
                  <p id="bootstrap-password-error" role="alert" className="text-[12.5px] text-danger">
                    {fieldErrors.password}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={bootstrapPending}
                className="mt-0.5 h-11 rounded-[11px] bg-accent text-[14.5px] font-bold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {bootstrapPending ? t("auth.bootstrap.submitting") : t("auth.bootstrap.submit")}
              </button>
              {bootstrapError && (
                <p role="alert" className="text-[12.5px] text-danger">
                  {t(
                    bootstrapError === "rate_limited"
                      ? "auth.bootstrap.errors.too_many_requests"
                      : bootstrapError === "network"
                        ? "auth.bootstrap.errors.network_error"
                        : "auth.bootstrap.error",
                  )}
                </p>
              )}
            </form>
          </>
        )}
      </div>
      <p className="mt-[22px] flex items-center gap-2 text-[11.5px] text-muted">
        <span className="font-bold tracking-[0.14em] text-accent-text">CÉFIRO</span> · {t("app.sealMotto")}
      </p>
    </main>
  );
}
