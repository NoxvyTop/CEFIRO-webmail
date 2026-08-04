import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import { createSessionStore } from "./sessions";
import { createAuthRouter } from "./router";
import { createBootstrap } from "../setup/bootstrap";
import { createApp } from "../../app";

const sql = createDb(testDatabaseUrl());
const sessions = createSessionStore(sql);

// Operator-set break-glass credential (GH #235): the process no longer mints
// one, so a bootstrap that is meant to be enabled has to be handed a secret.
const BOOTSTRAP_PASSWORD = "test-bootstrap-secret-0123456789";

afterAll(() => sql.end());

function appWith(enabled: boolean) {
  return createApp({
    authRouter: createAuthRouter({
      sessions,
      bootstrap: createBootstrap(enabled, BOOTSTRAP_PASSWORD),
    }),
  });
}

describe("GET /api/auth/mode", () => {
  it("reports bootstrapMode true when enabled", async () => {
    const res = await appWith(true).request("/api/auth/mode");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bootstrapMode: boolean }).bootstrapMode).toBe(true);
  });
  it("reports false when disabled and with no bootstrap dep", async () => {
    expect(
      ((await (await appWith(false).request("/api/auth/mode")).json()) as { bootstrapMode: boolean })
        .bootstrapMode,
    ).toBe(false);
    const noDep = createApp({ authRouter: createAuthRouter({ sessions }) });
    expect(
      ((await (await noDep.request("/api/auth/mode")).json()) as { bootstrapMode: boolean })
        .bootstrapMode,
    ).toBe(false);
  });

  // #290: the login-button provider name rides on this same public probe.
  function modeAppWith(provider: SsoConfigRepo["getProviderName"] | null) {
    return createApp({
      authRouter: createAuthRouter({
        sessions,
        bootstrap: createBootstrap(false, BOOTSTRAP_PASSWORD),
        ...(provider
          ? { ssoConfig: { getProviderName: provider } as unknown as SsoConfigRepo }
          : {}),
      }),
    });
  }

  async function providerNameOf(app: ReturnType<typeof createApp>): Promise<string> {
    return ((await (await app.request("/api/auth/mode")).json()) as { providerName: string })
      .providerName;
  }

  it("defaults providerName to SSO when no sso config is wired in", async () => {
    expect(await providerNameOf(modeAppWith(null))).toBe("SSO");
  });

  it("returns the configured providerName from the sso config", async () => {
    expect(await providerNameOf(modeAppWith(async () => "Authentik"))).toBe("Authentik");
  });

  it("falls back to SSO when the stored providerName is blank", async () => {
    expect(await providerNameOf(modeAppWith(async () => "   "))).toBe("SSO");
    expect(await providerNameOf(modeAppWith(async () => null))).toBe("SSO");
  });

  it("falls back to SSO when reading the sso config throws", async () => {
    expect(
      await providerNameOf(
        modeAppWith(async () => {
          throw new Error("db down");
        }),
      ),
    ).toBe("SSO");
  });
});
