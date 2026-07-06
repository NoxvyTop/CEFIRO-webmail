import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5434/db",
  MASTER_KEY: "A".repeat(44),
  APP_URL: "http://localhost:5173",
};

describe("loadConfig", () => {
  it("parses a valid environment with defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(8080);
    expect(config.bootstrapMode).toBe(false);
    expect(config.sessionTtlHours).toBe(12);
    expect(config.appUrl).toBe("http://localhost:5173");
  });

  it("reads PORT, BOOTSTRAP_MODE and SESSION_TTL_HOURS", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "9000",
      BOOTSTRAP_MODE: "true",
      SESSION_TTL_HOURS: "2",
    });
    expect(config.port).toBe(9000);
    expect(config.bootstrapMode).toBe(true);
    expect(config.sessionTtlHours).toBe(2);
  });

  it("accepts BOOTSTRAP_MODE=1 as true", () => {
    expect(loadConfig({ ...validEnv, BOOTSTRAP_MODE: "1" }).bootstrapMode).toBe(true);
  });

  it("rejects a missing MASTER_KEY", () => {
    expect(() => loadConfig({ ...validEnv, MASTER_KEY: undefined })).toThrow();
  });

  it("rejects a MASTER_KEY that is not 44 chars", () => {
    expect(() => loadConfig({ ...validEnv, MASTER_KEY: "short" })).toThrow();
  });

  it("rejects a non-url APP_URL", () => {
    expect(() => loadConfig({ ...validEnv, APP_URL: "not-a-url" })).toThrow();
  });

  it("parses optional STALWART_URL and treats empty as undefined", () => {
    expect(loadConfig(validEnv).stalwartUrl).toBeUndefined();
    expect(loadConfig({ ...validEnv, STALWART_URL: "" }).stalwartUrl).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, STALWART_URL: "https://mail.noxvytop.com" }).stalwartUrl,
    ).toBe("https://mail.noxvytop.com");
  });
});
