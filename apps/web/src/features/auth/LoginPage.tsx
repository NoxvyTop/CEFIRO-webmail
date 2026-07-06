import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

const KNOWN_ERRORS = new Set(["state", "unknown_user", "oidc"]);

export function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const error = params.get("auth_error");

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
    </main>
  );
}
