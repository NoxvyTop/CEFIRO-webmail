import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  setupSsoSchema,
  setupStatusSchema,
  setupUserSchema,
  type SetupStatus,
} from "@webmail/shared";
import { setupErrorKey } from "./errors";

type Phase = "token" | "connected" | "disabled";

// One shape for every step of the wizard so a request can only ever be idle,
// in flight, done, or failed with a specific code — never "pending AND error"
// at once, and never an error with no code behind it.
type StepState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success" }
  | { status: "error"; code: string };

const IDLE: StepState = { status: "idle" };

const DEFAULT_SSO = {
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
  providerName: "",
};
const DEFAULT_USER = {
  email: "",
  displayName: "",
  role: "employee" as "employee" | "admin",
  locale: "es",
  mailPassword: "",
};

// The server's error envelope is `{ code, message, traceId }` (core/
// error-response.ts). Read the code so a failure can be mapped to a specific
// message instead of a generic one; a body that is missing, not JSON, or has no
// string code degrades to null and the caller falls back to the generic key.
async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

export function SetupPage() {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("token");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [tokenState, setTokenState] = useState<StepState>(IDLE);
  const [ssoState, setSsoState] = useState<StepState>(IDLE);
  const [userState, setUserState] = useState<StepState>(IDLE);
  const [sso, setSso] = useState(DEFAULT_SSO);
  const [user, setUser] = useState(DEFAULT_USER);

  async function connect() {
    if (tokenState.status === "pending") return;
    setTokenState({ status: "pending" });
    try {
      const res = await fetch("/api/setup/status", { headers: { "x-setup-token": token } });
      if (res.status === 404) {
        setPhase("disabled");
        return;
      }
      if (!res.ok) {
        setTokenState({ status: "error", code: (await readErrorCode(res)) ?? "generic" });
        return;
      }
      setStatus(setupStatusSchema.parse(await res.json()));
      setPhase("connected");
    } catch {
      setTokenState({ status: "error", code: "network_error" });
    }
  }

  async function saveSso() {
    if (ssoState.status === "pending") return;
    const parsed = setupSsoSchema.safeParse(sso);
    if (!parsed.success) {
      setSsoState({ status: "error", code: "invalid_body" });
      return;
    }
    setSsoState({ status: "pending" });
    try {
      const res = await fetch("/api/setup/sso", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-setup-token": token },
        body: JSON.stringify(parsed.data),
      });
      if (res.ok) {
        setSsoState({ status: "success" });
      } else {
        setSsoState({ status: "error", code: (await readErrorCode(res)) ?? "generic" });
      }
    } catch {
      setSsoState({ status: "error", code: "network_error" });
    }
  }

  async function createUser() {
    if (userState.status === "pending") return;
    const parsed = setupUserSchema.safeParse(user);
    if (!parsed.success) {
      setUserState({ status: "error", code: "invalid_body" });
      return;
    }
    setUserState({ status: "pending" });
    try {
      const res = await fetch("/api/setup/users", {
        method: "POST",
        headers: { "content-type": "application/json", "x-setup-token": token },
        body: JSON.stringify(parsed.data),
      });
      if (res.ok) {
        setUserState({ status: "success" });
      } else {
        setUserState({ status: "error", code: (await readErrorCode(res)) ?? "generic" });
      }
    } catch {
      setUserState({ status: "error", code: "network_error" });
    }
  }

  // The email conflict (409 user_exists) is the one create-user failure that
  // points at a specific field, so it drives aria-invalid on the email input.
  const userEmailInvalid = userState.status === "error" && userState.code === "user_exists";

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6 text-ink">
      <h1 className="text-2xl font-semibold">{t("setup.title")}</h1>

      {phase === "disabled" && (
        <p role="alert" className="text-sm text-danger">
          {t("setup.disabled")}
        </p>
      )}

      {phase === "token" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
          className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5"
        >
          <label htmlFor="setup-token">{t("setup.tokenLabel")}</label>
          <input
            id="setup-token"
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setTokenState(IDLE);
            }}
            aria-invalid={tokenState.status === "error" ? true : undefined}
            aria-describedby={tokenState.status === "error" ? "setup-token-error" : undefined}
            className="rounded-md border border-line bg-soft p-1 text-ink field-focus"
          />
          <button
            type="submit"
            disabled={tokenState.status === "pending"}
            className="self-start rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink transition hover:brightness-[1.07] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {tokenState.status === "pending" ? t("setup.connecting") : t("setup.connect")}
          </button>
          {tokenState.status === "error" && (
            <p id="setup-token-error" role="alert" className="text-sm text-danger">
              {t(setupErrorKey(tokenState.code))}
            </p>
          )}
        </form>
      )}

      {phase === "connected" && status && (
        <>
          <p className="text-xs text-muted">
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
            className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5"
          >
            <h2 className="text-lg font-medium">{t("setup.ssoTitle")}</h2>

            <label htmlFor="sso-issuer">{t("setup.fields.issuer")}</label>
            <input
              id="sso-issuer"
              type="text"
              value={sso.issuer}
              onChange={(event) => setSso({ ...sso, issuer: event.target.value })}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <label htmlFor="sso-client-id">{t("setup.fields.clientId")}</label>
            <input
              id="sso-client-id"
              type="text"
              value={sso.clientId}
              onChange={(event) => setSso({ ...sso, clientId: event.target.value })}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <label htmlFor="sso-client-secret">{t("setup.fields.clientSecret")}</label>
            <input
              id="sso-client-secret"
              type="password"
              value={sso.clientSecret}
              onChange={(event) => setSso({ ...sso, clientSecret: event.target.value })}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <label htmlFor="sso-scopes">{t("setup.fields.scopes")}</label>
            <input
              id="sso-scopes"
              type="text"
              value={sso.scopes}
              onChange={(event) => setSso({ ...sso, scopes: event.target.value })}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            {/* #290: optional display name for the login button; blank -> "SSO". */}
            <label htmlFor="sso-provider-name">{t("setup.fields.providerName")}</label>
            <input
              id="sso-provider-name"
              type="text"
              value={sso.providerName}
              onChange={(event) => setSso({ ...sso, providerName: event.target.value })}
              placeholder="SSO"
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <button
              type="submit"
              disabled={ssoState.status === "pending"}
              className="h-11 self-start rounded-[11px] bg-accent px-4 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {ssoState.status === "pending" ? t("setup.saving") : t("setup.save")}
            </button>
            {ssoState.status === "success" && (
              <p className="text-sm text-accent-text">{t("setup.saved")}</p>
            )}
            {ssoState.status === "error" && (
              <p role="alert" className="text-sm text-danger">
                {t(setupErrorKey(ssoState.code))}
              </p>
            )}
          </form>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createUser();
            }}
            className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5"
          >
            <h2 className="text-lg font-medium">{t("setup.userTitle")}</h2>

            <label htmlFor="user-email">{t("setup.fields.email")}</label>
            <input
              id="user-email"
              type="email"
              value={user.email}
              onChange={(event) => {
                setUser({ ...user, email: event.target.value });
                setUserState(IDLE);
              }}
              aria-invalid={userEmailInvalid ? true : undefined}
              aria-describedby={userEmailInvalid ? "setup-user-error" : undefined}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <label htmlFor="user-display-name">{t("setup.fields.displayName")}</label>
            <input
              id="user-display-name"
              type="text"
              value={user.displayName}
              onChange={(event) => setUser({ ...user, displayName: event.target.value })}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <label htmlFor="user-role">{t("setup.fields.role")}</label>
            <select
              id="user-role"
              value={user.role}
              onChange={(event) =>
                setUser({ ...user, role: event.target.value as "employee" | "admin" })
              }
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            >
              <option value="employee">employee</option>
              <option value="admin">admin</option>
            </select>

            <label htmlFor="user-locale">{t("setup.fields.locale")}</label>
            <select
              id="user-locale"
              value={user.locale}
              onChange={(event) => setUser({ ...user, locale: event.target.value })}
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
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
              className="h-11 rounded-[10px] border border-line bg-soft px-3.5 text-[14px] text-ink field-focus"
            />

            <button
              type="submit"
              disabled={userState.status === "pending"}
              className="h-11 self-start rounded-[11px] bg-accent px-4 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {userState.status === "pending" ? t("setup.creating") : t("setup.create")}
            </button>
            {userState.status === "success" && (
              <p className="text-sm text-accent-text">{t("setup.created")}</p>
            )}
            {userState.status === "error" && (
              <p id="setup-user-error" role="alert" className="text-sm text-danger">
                {t(setupErrorKey(userState.code))}
              </p>
            )}
          </form>
        </>
      )}
    </main>
  );
}
