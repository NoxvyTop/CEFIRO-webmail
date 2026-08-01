import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { DomainError } from "../../core/errors";
import { importMasterKey } from "../credentials/crypto";
import type { AuditEntry, AuditRepo } from "../../infra/repos/audit";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UserRecord, UsersRepo } from "../../infra/repos/users";
import { createAuthRouter, type OidcClient } from "./router";
import { discover } from "./oidc";
import type { SessionStore } from "./sessions";

// Failure paths of the OIDC login, with every dependency faked so a provider
// outage, a bad token and a database error can each be produced exactly (GH
// #236 and #237). The happy path lives in login-flow.test.ts, against the
// database.

const ID_TOKEN = "eyJ-pretend-this-is-a-real-id-token";
const CLIENT_SECRET = "the-client-secret";
const APP_URL = "http://localhost:5173";

let masterKey: CryptoKey;
/** A state/cookie pair from a real login start — see `callback` below. */
let started: { state: string; sealed: string };

beforeAll(async () => {
  masterKey = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  const login = await makeApp({}).request("/api/auth/login");
  started = {
    state: new URL(login.headers.get("location")!).searchParams.get("state")!,
    sealed: cookieValue(login, "oidc_state")!,
  };
});

/** What fetch does when the identity provider cannot be reached at all. */
function refusedFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

/** A jose verification failure, which is a named class and nothing else. */
class JWTExpired extends Error {
  constructor() {
    super('"exp" claim timestamp check failed');
    this.name = "JWTExpired";
  }
}

const user: UserRecord = {
  id: "user-1",
  email: "someone@noxvytop.com",
  displayName: "Someone",
  role: "employee",
  locale: "es",
  active: true,
};

function fakeSsoConfig(): SsoConfigRepo {
  return {
    get: async () => ({
      issuer: "https://auth.test",
      clientId: "webmail",
      clientSecret: CLIENT_SECRET,
      scopes: "openid email",
    }),
  } as unknown as SsoConfigRepo;
}

function fakeSessions(): SessionStore {
  return {
    create: vi.fn(async () => ({ token: "session-token", expiresAt: new Date() })),
  } as unknown as SessionStore;
}

const workingOidc: OidcClient = {
  discover: async () => ({
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    jwksUri: "https://auth.test/jwks",
  }),
  exchangeCode: async () => ({ idToken: ID_TOKEN }),
  createVerifier: () => async () => ({ email: user.email }),
};

function makeApp(overrides: {
  oidc?: Partial<OidcClient>;
  users?: Partial<UsersRepo>;
  audit?: { record: (entry: AuditEntry) => Promise<void> };
}) {
  const users = {
    findByEmail: async () => user,
    create: async () => user,
    ...overrides.users,
  } as unknown as UsersRepo;
  return createApp({
    authRouter: createAuthRouter({
      sessions: fakeSessions(),
      users,
      audit: (overrides.audit ?? { record: vi.fn(async () => {}) }) as unknown as AuditRepo,
      ssoConfig: fakeSsoConfig(),
      masterKey,
      appUrl: APP_URL,
      sessionTtlHours: 1,
      oidcClient: { ...workingOidc, ...overrides.oidc },
    }),
  });
}

type LogLine = Record<string, unknown>;

/** Collects the JSON lines the logger writes while `run` runs. */
async function captureLogs(run: () => Promise<void>): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const record = (...args: unknown[]) => {
    lines.push(JSON.parse(String(args[0])) as LogLine);
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
  ];
  try {
    await run();
    return lines;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function cookieValue(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    if (line.startsWith(`${name}=`)) return line.split(";")[0]!.slice(name.length + 1);
  }
  return null;
}

/**
 * Hits the callback with the state and sealed cookie a real login start
 * produced, so the state check — which runs BEFORE the try block this suite is
 * about — is satisfied and the request reaches the flow under test.
 *
 * The pair is minted once, by a working app, rather than by `app`: several of
 * these tests break the login start too, and the cookie is sealed with a key,
 * not with a per-app session, so it opens anywhere that key does.
 */
async function callback(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.request(`/api/auth/callback?code=abc&state=${started.state}`, {
    headers: { cookie: `oidc_state=${started.sealed}` },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unreachable identity provider through the router (GH #236)", () => {
  it("answers GET /login with 502 oidc_unavailable instead of 500 internal", async () => {
    // The real discover(), with a fetch that refuses the connection: this is
    // the path that used to produce a 500 blaming CEFIRO for the IdP being
    // down, and an "unhandled error" line beside the genuine bugs.
    const app = makeApp({ oidc: { discover: (issuer) => discover(issuer, refusedFetch()) } });

    const res = await app.request("/api/auth/login");

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("oidc_unavailable");
  });

  it("redirects the callback to auth_error=oidc rather than surfacing a 500", async () => {
    const app = makeApp({
      oidc: { exchangeCode: () => Promise.reject(new TypeError("fetch failed")) },
    });

    const res = await callback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?auth_error=oidc");
  });
});

// GH #237. Every one of these used to end at the same `?auth_error=oidc` and
// the same `login.failed` audit row with actor "system", with the error object
// dropped on the floor by a bare `catch {}`.
describe("oidc callback failure logging (GH #237)", () => {
  /** The single `oidc callback failed` line a request produced. */
  function failureLine(lines: LogLine[]): LogLine {
    const found = lines.filter((line) => line.msg === "oidc callback failed");
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it("names the stage and the error class, correlated by traceId", async () => {
    const app = makeApp({
      oidc: { exchangeCode: () => Promise.reject(new TypeError("fetch failed")) },
    });

    let res!: Response;
    const lines = await captureLogs(async () => {
      res = await callback(app);
    });

    const line = failureLine(lines);
    expect(line.stage).toBe("token_exchange");
    expect(line.errorClass).toBe("TypeError");
    expect(line.level).toBe("warn");
    // The traceId the browser was handed on the way out is the one on this
    // line, which is what makes an incident followable (GH #219).
    expect(line.traceId).toBe(res.headers.get("x-trace-id"));
    expect(line.traceId).toBeTruthy();
  });

  it("tells a DomainError from the provider apart by its code", async () => {
    const app = makeApp({
      oidc: {
        discover: () =>
          Promise.reject(new DomainError("oidc_unavailable", 502, "errors.oidc_unavailable")),
      },
    });

    const lines = await captureLogs(async () => {
      await callback(app);
    });

    expect(failureLine(lines)).toMatchObject({
      stage: "discovery",
      errorClass: "DomainError",
      errorCode: "oidc_unavailable",
    });
  });

  it("distinguishes a rejected id token from a provider that never answered", async () => {
    const app = makeApp({
      oidc: {
        createVerifier: () => () => Promise.reject(new JWTExpired()),
      },
    });

    const lines = await captureLogs(async () => {
      await callback(app);
    });

    // Clock skew, told apart from an outage by class alone — the whole point.
    expect(failureLine(lines)).toMatchObject({ stage: "id_token", errorClass: "JWTExpired" });
  });

  it("distinguishes a database failure while provisioning the user", async () => {
    const app = makeApp({
      users: {
        findByEmail: async () => null,
        create: () =>
          Promise.reject(Object.assign(new Error("insert failed"), { name: "PostgresError" })),
      },
    });

    const lines = await captureLogs(async () => {
      await callback(app);
    });

    expect(failureLine(lines)).toMatchObject({
      stage: "user_provision",
      errorClass: "PostgresError",
    });
  });

  it("never writes the id token, the client secret or the error message", async () => {
    const app = makeApp({
      oidc: { createVerifier: () => () => Promise.reject(new JWTExpired()) },
    });

    const lines = await captureLogs(async () => {
      await callback(app);
    });

    const written = JSON.stringify(lines);
    expect(written).not.toContain(ID_TOKEN);
    expect(written).not.toContain(CLIENT_SECRET);
    // The class is published, the message is not: it is text of unknown
    // provenance travelling into the log stream.
    expect(written).not.toContain("claim timestamp check failed");
  });

  it("still redirects when the audit write is the thing that fails", async () => {
    const app = makeApp({
      users: {
        findByEmail: () =>
          Promise.reject(Object.assign(new Error("down"), { name: "PostgresError" })),
      },
      audit: {
        record: () => Promise.reject(Object.assign(new Error("down"), { name: "PostgresError" })),
      },
    });

    let res!: Response;
    const lines = await captureLogs(async () => {
      res = await callback(app);
    });

    // A Postgres that is down takes the audit row with it. The user is still
    // owed the redirect, and the diagnosis survives in the log either way.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?auth_error=oidc");
    expect(failureLine(lines)).toMatchObject({ stage: "user_lookup" });
    expect(lines.some((line) => line.msg === "oidc callback audit write failed")).toBe(true);
  });
});
