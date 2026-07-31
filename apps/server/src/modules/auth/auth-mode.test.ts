import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { createSessionStore } from "./sessions";
import { createAuthRouter } from "./router";
import { createBootstrap } from "../setup/bootstrap";
import { createApp } from "../../app";

const sql = createDb(testDatabaseUrl());
const sessions = createSessionStore(sql);

afterAll(() => sql.end());

function appWith(enabled: boolean) {
  return createApp({
    authRouter: createAuthRouter({ sessions, bootstrap: createBootstrap(enabled) }),
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
});
