import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authModeSchema, type AuthMode } from "@webmail/shared";
import { bootstrapLogin } from "./useAuth";

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
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-semibold">{t("app.title")}</h1>
      {error && KNOWN_ERRORS.has(error) && (
        <p className="text-sm text-red-600">{t(`auth.errors.${error}`)}</p>
      )}
      <a
        href="/api/auth/login"
        className="rounded-md bg-blue-600 px-4 py-2 text-white"
      >
        {t("auth.signIn")}
      </a>
      {mode?.bootstrapMode === true && (
        <form
          onSubmit={handleBootstrapSubmit}
          aria-label={t("auth.bootstrap.title")}
          className="flex flex-col gap-3 rounded-md border border-gray-300 p-4"
        >
          <h2 className="text-lg font-medium">{t("auth.bootstrap.title")}</h2>
          <div className="flex flex-col gap-1">
            <label htmlFor="bootstrap-email">{t("auth.bootstrap.email")}</label>
            <input
              id="bootstrap-email"
              type="text"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="bootstrap-password">{t("auth.bootstrap.password")}</label>
            <input
              id="bootstrap-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className="rounded-md bg-gray-700 px-4 py-2 text-white">
            {t("auth.bootstrap.submit")}
          </button>
          {bootstrapError && (
            <p className="text-sm text-red-600">{t("auth.bootstrap.error")}</p>
          )}
          <p className="text-xs text-gray-500">{t("auth.bootstrap.hint")}</p>
        </form>
      )}
    </main>
  );
}
