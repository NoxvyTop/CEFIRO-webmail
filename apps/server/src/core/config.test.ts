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

  describe("master key rotation (single key by default)", () => {
    const retiredKey = "B".repeat(44);

    it("defaults to version 1 with no retired keys", () => {
      const config = loadConfig(validEnv);
      expect(config.masterKeyVersion).toBe(1);
      expect(config.previousMasterKeys).toEqual([]);
    });

    it("treats an empty MASTER_KEY_PREVIOUS as no retired keys", () => {
      expect(loadConfig({ ...validEnv, MASTER_KEY_PREVIOUS: "" }).previousMasterKeys).toEqual(
        [],
      );
    });

    it("reads MASTER_KEY_VERSION and the retired keys it needs", () => {
      const config = loadConfig({
        ...validEnv,
        MASTER_KEY_VERSION: "2",
        MASTER_KEY_PREVIOUS: `1:${retiredKey}`,
      });
      expect(config.masterKeyVersion).toBe(2);
      expect(config.previousMasterKeys).toEqual([{ version: 1, key: retiredKey }]);
    });

    it("reads several retired keys and ignores surrounding whitespace", () => {
      const config = loadConfig({
        ...validEnv,
        MASTER_KEY_VERSION: "3",
        MASTER_KEY_PREVIOUS: ` 1:${retiredKey}, 2:${"C".repeat(44)} `,
      });
      expect(config.previousMasterKeys).toEqual([
        { version: 1, key: retiredKey },
        { version: 2, key: "C".repeat(44) },
      ]);
    });

    it("rejects a retired key with no version prefix", () => {
      expect(() =>
        loadConfig({ ...validEnv, MASTER_KEY_PREVIOUS: retiredKey }),
      ).toThrow();
    });

    it("rejects a retired key that is not 44 chars", () => {
      expect(() => loadConfig({ ...validEnv, MASTER_KEY_PREVIOUS: "1:short" })).toThrow();
    });

    it("rejects a non-numeric retired key version", () => {
      expect(() =>
        loadConfig({ ...validEnv, MASTER_KEY_PREVIOUS: `old:${retiredKey}` }),
      ).toThrow();
    });

    it("rejects the same retired version declared twice", () => {
      expect(() =>
        loadConfig({
          ...validEnv,
          MASTER_KEY_VERSION: "2",
          MASTER_KEY_PREVIOUS: `1:${retiredKey},1:${"C".repeat(44)}`,
        }),
      ).toThrow();
    });

    it("rejects a retired key that reuses the current MASTER_KEY_VERSION", () => {
      expect(() =>
        loadConfig({
          ...validEnv,
          MASTER_KEY_VERSION: "2",
          MASTER_KEY_PREVIOUS: `2:${retiredKey}`,
        }),
      ).toThrow();
    });

    it("rejects a MASTER_KEY_VERSION below 1", () => {
      expect(() => loadConfig({ ...validEnv, MASTER_KEY_VERSION: "0" })).toThrow();
    });

    it("rejects a non-numeric MASTER_KEY_VERSION", () => {
      expect(() => loadConfig({ ...validEnv, MASTER_KEY_VERSION: "latest" })).toThrow();
    });
  });

  it("parses optional STALWART_URL and treats empty as undefined", () => {
    expect(loadConfig(validEnv).stalwartUrl).toBeUndefined();
    expect(loadConfig({ ...validEnv, STALWART_URL: "" }).stalwartUrl).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, STALWART_URL: "https://mail.noxvytop.com" }).stalwartUrl,
    ).toBe("https://mail.noxvytop.com");
  });

  describe("JMAP_FORCE_BASE (off by default)", () => {
    it("defaults jmapForceBase to false when JMAP_FORCE_BASE is absent", () => {
      expect(loadConfig(validEnv).jmapForceBase).toBe(false);
    });

    it("parses JMAP_FORCE_BASE=true the same way BOOTSTRAP_MODE is parsed", () => {
      expect(loadConfig({ ...validEnv, JMAP_FORCE_BASE: "true" }).jmapForceBase).toBe(true);
    });

    it("parses JMAP_FORCE_BASE=1 as true", () => {
      expect(loadConfig({ ...validEnv, JMAP_FORCE_BASE: "1" }).jmapForceBase).toBe(true);
    });

    it("treats any other JMAP_FORCE_BASE value as false", () => {
      expect(loadConfig({ ...validEnv, JMAP_FORCE_BASE: "yes" }).jmapForceBase).toBe(false);
    });
  });

  describe("AI feature gate (off by default)", () => {
    it("defaults aiEnabled to false when AI_ENABLED is absent", () => {
      expect(loadConfig(validEnv).aiEnabled).toBe(false);
    });

    it("defaults aiProvider to anthropic when AI_PROVIDER is absent", () => {
      expect(loadConfig(validEnv).aiProvider).toBe("anthropic");
    });

    it("defaults aiModel to claude-opus-4-8 when AI_MODEL is absent", () => {
      expect(loadConfig(validEnv).aiModel).toBe("claude-opus-4-8");
    });

    it("leaves aiApiKey undefined when AI_API_KEY is absent", () => {
      expect(loadConfig(validEnv).aiApiKey).toBeUndefined();
    });

    it("parses AI_ENABLED=true the same way BOOTSTRAP_MODE is parsed", () => {
      expect(loadConfig({ ...validEnv, AI_ENABLED: "true" }).aiEnabled).toBe(true);
    });

    it("parses AI_ENABLED=1 as true", () => {
      expect(loadConfig({ ...validEnv, AI_ENABLED: "1" }).aiEnabled).toBe(true);
    });

    it("treats any other AI_ENABLED value as false", () => {
      expect(loadConfig({ ...validEnv, AI_ENABLED: "yes" }).aiEnabled).toBe(false);
    });

    it("reads AI_PROVIDER, AI_API_KEY and AI_MODEL overrides from env", () => {
      const config = loadConfig({
        ...validEnv,
        AI_ENABLED: "true",
        AI_PROVIDER: "anthropic",
        AI_API_KEY: "sk-ant-secret",
        AI_MODEL: "claude-custom-model",
      });
      expect(config.aiProvider).toBe("anthropic");
      expect(config.aiApiKey).toBe("sk-ant-secret");
      expect(config.aiModel).toBe("claude-custom-model");
    });

    it("leaves aiBaseUrl undefined when AI_BASE_URL is absent", () => {
      expect(loadConfig(validEnv).aiBaseUrl).toBeUndefined();
    });

    it("treats an empty AI_BASE_URL as undefined", () => {
      expect(loadConfig({ ...validEnv, AI_BASE_URL: "" }).aiBaseUrl).toBeUndefined();
    });

    it("reads AI_BASE_URL, including a /v1 suffix, verbatim", () => {
      const config = loadConfig({
        ...validEnv,
        AI_PROVIDER: "openai-compat",
        AI_BASE_URL: "https://api.moonshot.cn/v1",
      });
      expect(config.aiBaseUrl).toBe("https://api.moonshot.cn/v1");
    });

    it("accepts openai-compat as an explicit aiProvider value", () => {
      expect(loadConfig({ ...validEnv, AI_PROVIDER: "openai-compat" }).aiProvider).toBe(
        "openai-compat",
      );
    });
  });
});
