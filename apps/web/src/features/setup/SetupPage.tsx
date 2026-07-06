import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  setupSsoSchema,
  setupStatusSchema,
  setupUserSchema,
  type SetupStatus,
} from "@webmail/shared";

type Phase = "token" | "connected" | "disabled";

const DEFAULT_SSO = { issuer: "", clientId: "", clientSecret: "", scopes: "openid profile email" };
const DEFAULT_USER = {
  email: "",
  displayName: "",
  role: "employee" as "employee" | "admin",
  locale: "es",
  mailPassword: "",
};

export function SetupPage() {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("token");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [ssoResult, setSsoResult] = useState<"idle" | "saved" | "error">("idle");
  const [userResult, setUserResult] = useState<"idle" | "created" | "error">("idle");
  const [sso, setSso] = useState(DEFAULT_SSO);
  const [user, setUser] = useState(DEFAULT_USER);

  async function connect() {
    const res = await fetch("/api/setup/status", { headers: { "x-setup-token": token } });
    if (res.status === 404) return setPhase("disabled");
    if (!res.ok) return setPhase("token");
    setStatus(setupStatusSchema.parse(await res.json()));
    setPhase("connected");
  }

  async function saveSso() {
    const parsed = setupSsoSchema.safeParse(sso);
    if (!parsed.success) return setSsoResult("error");
    const res = await fetch("/api/setup/sso", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-setup-token": token },
      body: JSON.stringify(parsed.data),
    });
    setSsoResult(res.ok ? "saved" : "error");
  }

  async function createUser() {
    const parsed = setupUserSchema.safeParse(user);
    if (!parsed.success) return setUserResult("error");
    const res = await fetch("/api/setup/users", {
      method: "POST",
      headers: { "content-type": "application/json", "x-setup-token": token },
      body: JSON.stringify(parsed.data),
    });
    setUserResult(res.ok ? "created" : "error");
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">{t("setup.title")}</h1>

      {phase === "disabled" && <p role="alert">{t("setup.disabled")}</p>}

      {phase === "token" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="setup-token">{t("setup.tokenLabel")}</label>
          <input
            id="setup-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit">{t("setup.connect")}</button>
        </form>
      )}

      {phase === "connected" && status && (
        <>
          <p>
            {t("setup.status", {
              sso: status.ssoConfigured ? "yes" : "no",
              count: status.userCount,
            })}
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveSso();
            }}
            className="flex flex-col gap-3"
          >
            <h2 className="text-lg font-medium">{t("setup.ssoTitle")}</h2>

            <label htmlFor="sso-issuer">{t("setup.fields.issuer")}</label>
            <input
              id="sso-issuer"
              type="text"
              value={sso.issuer}
              onChange={(event) => setSso({ ...sso, issuer: event.target.value })}
            />

            <label htmlFor="sso-client-id">{t("setup.fields.clientId")}</label>
            <input
              id="sso-client-id"
              type="text"
              value={sso.clientId}
              onChange={(event) => setSso({ ...sso, clientId: event.target.value })}
            />

            <label htmlFor="sso-client-secret">{t("setup.fields.clientSecret")}</label>
            <input
              id="sso-client-secret"
              type="password"
              value={sso.clientSecret}
              onChange={(event) => setSso({ ...sso, clientSecret: event.target.value })}
            />

            <label htmlFor="sso-scopes">{t("setup.fields.scopes")}</label>
            <input
              id="sso-scopes"
              type="text"
              value={sso.scopes}
              onChange={(event) => setSso({ ...sso, scopes: event.target.value })}
            />

            <button type="submit">{t("setup.save")}</button>
            {ssoResult === "saved" && <p>{t("setup.saved")}</p>}
            {ssoResult === "error" && <p role="alert">{t("setup.error")}</p>}
          </form>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createUser();
            }}
            className="flex flex-col gap-3"
          >
            <h2 className="text-lg font-medium">{t("setup.userTitle")}</h2>

            <label htmlFor="user-email">{t("setup.fields.email")}</label>
            <input
              id="user-email"
              type="email"
              value={user.email}
              onChange={(event) => setUser({ ...user, email: event.target.value })}
            />

            <label htmlFor="user-display-name">{t("setup.fields.displayName")}</label>
            <input
              id="user-display-name"
              type="text"
              value={user.displayName}
              onChange={(event) => setUser({ ...user, displayName: event.target.value })}
            />

            <label htmlFor="user-role">{t("setup.fields.role")}</label>
            <select
              id="user-role"
              value={user.role}
              onChange={(event) =>
                setUser({ ...user, role: event.target.value as "employee" | "admin" })
              }
            >
              <option value="employee">employee</option>
              <option value="admin">admin</option>
            </select>

            <label htmlFor="user-locale">{t("setup.fields.locale")}</label>
            <select
              id="user-locale"
              value={user.locale}
              onChange={(event) => setUser({ ...user, locale: event.target.value })}
            >
              <option value="es">es</option>
              <option value="en">en</option>
            </select>

            <label htmlFor="user-mail-password">{t("setup.fields.mailPassword")}</label>
            <input
              id="user-mail-password"
              type="password"
              value={user.mailPassword}
              onChange={(event) => setUser({ ...user, mailPassword: event.target.value })}
            />

            <button type="submit">{t("setup.create")}</button>
            {userResult === "created" && <p>{t("setup.created")}</p>}
            {userResult === "error" && <p role="alert">{t("setup.error")}</p>}
          </form>
        </>
      )}
    </main>
  );
}
