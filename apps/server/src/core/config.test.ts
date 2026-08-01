import { describe, expect, it } from "vitest";
import { loadConfig, MIN_BOOTSTRAP_PASSWORD_LENGTH } from "./config";

/** A break-glass credential of the shape GH #235 asks the operator to set. */
const BOOTSTRAP_PASSWORD = "A".repeat(MIN_BOOTSTRAP_PASSWORD_LENGTH);

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5434/db",
  MASTER_KEY: "A".repeat(44),
  APP_URL: "http://localhost:5173",
};

// Stands in for a key produced by scripts/generate-master-key.ts: 32 distinct
// bytes, not all printable, so it passes the weakness check of GH #223.
const GENERATED_KEY = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 61 + 7) % 256)),
);

/** 32 zero bytes: the right length, no entropy at all. */
const ZERO_KEY = btoa(String.fromCharCode(...new Uint8Array(32)));

/** `validEnv` with a key that is acceptable outside development. */
const generatedKeyEnv = { ...validEnv, MASTER_KEY: GENERATED_KEY };

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
      BOOTSTRAP_PASSWORD,
      SESSION_TTL_HOURS: "2",
    });
    expect(config.port).toBe(9000);
    expect(config.bootstrapMode).toBe(true);
    expect(config.bootstrapPassword).toBe(BOOTSTRAP_PASSWORD);
    expect(config.sessionTtlHours).toBe(2);
  });

  it("accepts BOOTSTRAP_MODE=1 as true", () => {
    expect(
      loadConfig({ ...validEnv, BOOTSTRAP_MODE: "1", BOOTSTRAP_PASSWORD }).bootstrapMode,
    ).toBe(true);
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

  describe("outbound deadlines (GH #165)", () => {
    it("defaults every upstream deadline so no deployment has to set one", () => {
      const config = loadConfig(validEnv);
      expect(config.stalwartTimeoutMs).toBe(10_000);
      expect(config.aiTimeoutMs).toBe(60_000);
      expect(config.oidcTimeoutMs).toBe(10_000);
    });

    it("gives the AI provider a looser deadline than Stalwart by default", () => {
      const config = loadConfig(validEnv);
      expect(config.aiTimeoutMs).toBeGreaterThan(config.stalwartTimeoutMs);
    });

    it("reads STALWART_TIMEOUT_MS, AI_TIMEOUT_MS and OIDC_TIMEOUT_MS overrides", () => {
      const config = loadConfig({
        ...validEnv,
        STALWART_TIMEOUT_MS: "2500",
        AI_TIMEOUT_MS: "120000",
        OIDC_TIMEOUT_MS: "7000",
      });
      expect(config.stalwartTimeoutMs).toBe(2500);
      expect(config.aiTimeoutMs).toBe(120_000);
      expect(config.oidcTimeoutMs).toBe(7000);
    });

    it("treats an empty deadline variable as absent", () => {
      expect(loadConfig({ ...validEnv, STALWART_TIMEOUT_MS: "" }).stalwartTimeoutMs).toBe(10_000);
    });

    it("rejects a non-numeric deadline", () => {
      expect(() => loadConfig({ ...validEnv, AI_TIMEOUT_MS: "soon" })).toThrow();
    });

    it("rejects a zero or negative deadline, which would abort every call", () => {
      expect(() => loadConfig({ ...validEnv, STALWART_TIMEOUT_MS: "0" })).toThrow();
      expect(() => loadConfig({ ...validEnv, OIDC_TIMEOUT_MS: "-1" })).toThrow();
    });

    it("rejects a fractional deadline", () => {
      expect(() => loadConfig({ ...validEnv, AI_TIMEOUT_MS: "1500.5" })).toThrow();
    });
  });

  describe("NODE_ENV / isProduction (GH #196)", () => {
    it("defaults nodeEnv to development and isProduction to false", () => {
      const config = loadConfig(validEnv);
      expect(config.nodeEnv).toBe("development");
      expect(config.isProduction).toBe(false);
    });

    it("marks isProduction true only when NODE_ENV is exactly production", () => {
      expect(loadConfig({ ...generatedKeyEnv, NODE_ENV: "production" }).isProduction).toBe(true);
      expect(loadConfig({ ...generatedKeyEnv, NODE_ENV: "staging" }).isProduction).toBe(false);
      expect(loadConfig({ ...validEnv, NODE_ENV: "test" }).isProduction).toBe(false);
    });

    it("carries the raw NODE_ENV value through", () => {
      expect(loadConfig({ ...generatedKeyEnv, NODE_ENV: "staging" }).nodeEnv).toBe("staging");
    });
  });

  // GH #223: MASTER_KEY was validated for length only, so the key published in
  // docker-compose.dev.yml passed unchanged in production.
  describe("MASTER_KEY quality", () => {
    const DEV_COMPOSE_KEY = "ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE=";

    it("refuses the published dev compose key outside development", () => {
      expect(() =>
        loadConfig({ ...validEnv, MASTER_KEY: DEV_COMPOSE_KEY, NODE_ENV: "production" }),
      ).toThrow(/docker-compose\.dev\.yml/);
    });

    it("refuses a low-entropy key outside development", () => {
      expect(() =>
        loadConfig({ ...validEnv, MASTER_KEY: ZERO_KEY, NODE_ENV: "production" }),
      ).toThrow(/MASTER_KEY/);
    });

    it("refuses a weak key in any environment that is not development or test", () => {
      // The exemption is an allowlist on purpose: a deployment that calls
      // itself "staging" or "prod" is covered without having to be enumerated.
      for (const nodeEnv of ["staging", "prod", "produccion", "preproduc"]) {
        expect(() =>
          loadConfig({ ...validEnv, MASTER_KEY: DEV_COMPOSE_KEY, NODE_ENV: nodeEnv }),
        ).toThrow(/MASTER_KEY/);
      }
    });

    it("keeps the dev compose key working in development and test", () => {
      expect(loadConfig({ ...validEnv, MASTER_KEY: DEV_COMPOSE_KEY }).masterKey).toBe(
        DEV_COMPOSE_KEY,
      );
      expect(
        loadConfig({ ...validEnv, MASTER_KEY: DEV_COMPOSE_KEY, NODE_ENV: "test" }).masterKey,
      ).toBe(DEV_COMPOSE_KEY);
    });

    it("accepts a generated key in production", () => {
      expect(loadConfig({ ...generatedKeyEnv, NODE_ENV: "production" }).masterKey).toBe(
        GENERATED_KEY,
      );
    });

    it("points at the generator script instead of just refusing", () => {
      expect(() =>
        loadConfig({ ...validEnv, MASTER_KEY: ZERO_KEY, NODE_ENV: "production" }),
      ).toThrow(/generate-master-key/);
    });

    it("does not check retired keys, so rotating away from a weak one can boot", () => {
      // A deployment stuck on a weak key rotates out of it: the new key becomes
      // current and the weak one stays listed only to read rows sealed before
      // the rotation. Refusing it there would make the fix impossible to apply.
      const config = loadConfig({
        ...generatedKeyEnv,
        NODE_ENV: "production",
        MASTER_KEY_VERSION: "2",
        MASTER_KEY_PREVIOUS: `1:${DEV_COMPOSE_KEY}`,
      });
      expect(config.previousMasterKeys).toEqual([{ version: 1, key: DEV_COMPOSE_KEY }]);
    });
  });

  describe("global body limit (GH #195)", () => {
    it("defaults maxBodyBytes so no deployment has to set one", () => {
      expect(loadConfig(validEnv).maxBodyBytes).toBe(2 * 1024 * 1024);
    });

    it("reads a MAX_BODY_BYTES override", () => {
      expect(loadConfig({ ...validEnv, MAX_BODY_BYTES: "524288" }).maxBodyBytes).toBe(524_288);
    });

    it("treats an empty MAX_BODY_BYTES as absent", () => {
      expect(loadConfig({ ...validEnv, MAX_BODY_BYTES: "" }).maxBodyBytes).toBe(2 * 1024 * 1024);
    });

    it("rejects a zero, negative or fractional MAX_BODY_BYTES", () => {
      expect(() => loadConfig({ ...validEnv, MAX_BODY_BYTES: "0" })).toThrow();
      expect(() => loadConfig({ ...validEnv, MAX_BODY_BYTES: "-1" })).toThrow();
      expect(() => loadConfig({ ...validEnv, MAX_BODY_BYTES: "1.5" })).toThrow();
    });
  });

  describe("database pool + timeouts (GH #191)", () => {
    it("defaults the pool and every DB timeout so no deployment has to set one", () => {
      const config = loadConfig(validEnv);
      expect(config.dbPoolMax).toBe(10);
      expect(config.dbConnectTimeoutS).toBe(10);
      expect(config.dbIdleTimeoutS).toBe(300);
      expect(config.dbStatementTimeoutMs).toBe(30_000);
    });

    it("reads DB_POOL_MAX, DB_CONNECT_TIMEOUT_S, DB_IDLE_TIMEOUT_S and DB_STATEMENT_TIMEOUT_MS overrides", () => {
      const config = loadConfig({
        ...validEnv,
        DB_POOL_MAX: "20",
        DB_CONNECT_TIMEOUT_S: "5",
        DB_IDLE_TIMEOUT_S: "120",
        DB_STATEMENT_TIMEOUT_MS: "15000",
      });
      expect(config.dbPoolMax).toBe(20);
      expect(config.dbConnectTimeoutS).toBe(5);
      expect(config.dbIdleTimeoutS).toBe(120);
      expect(config.dbStatementTimeoutMs).toBe(15_000);
    });

    it("treats an empty DB variable as absent", () => {
      expect(loadConfig({ ...validEnv, DB_STATEMENT_TIMEOUT_MS: "" }).dbStatementTimeoutMs).toBe(
        30_000,
      );
    });

    it("rejects a non-numeric DB limit", () => {
      expect(() => loadConfig({ ...validEnv, DB_POOL_MAX: "many" })).toThrow();
    });

    it("rejects a zero or negative DB limit, which would break the pool", () => {
      expect(() => loadConfig({ ...validEnv, DB_POOL_MAX: "0" })).toThrow();
      expect(() => loadConfig({ ...validEnv, DB_CONNECT_TIMEOUT_S: "-1" })).toThrow();
    });

    it("rejects a fractional DB limit", () => {
      expect(() => loadConfig({ ...validEnv, DB_IDLE_TIMEOUT_S: "12.5" })).toThrow();
    });
  });

  // GH #218: these three used to bypass the schema entirely. The shutdown
  // budgets went through a local `positiveIntEnv` in index.ts that swallowed a
  // malformed value and silently used the default, and STATIC_DIR was read
  // straight from the environment.
  describe("shutdown budgets and STATIC_DIR", () => {
    it("defaults both shutdown budgets to core/shutdown.ts's own fallbacks", () => {
      const config = loadConfig(validEnv);
      expect(config.shutdownGraceMs).toBe(15_000);
      expect(config.shutdownDbTimeoutMs).toBe(5_000);
    });

    it("reads SHUTDOWN_GRACE_MS and SHUTDOWN_DB_TIMEOUT_MS overrides", () => {
      const config = loadConfig({
        ...validEnv,
        SHUTDOWN_GRACE_MS: "30000",
        SHUTDOWN_DB_TIMEOUT_MS: "2000",
      });
      expect(config.shutdownGraceMs).toBe(30_000);
      expect(config.shutdownDbTimeoutMs).toBe(2000);
    });

    it("treats an empty shutdown budget as absent", () => {
      expect(loadConfig({ ...validEnv, SHUTDOWN_GRACE_MS: "" }).shutdownGraceMs).toBe(15_000);
    });

    it("fails loudly on a malformed shutdown budget instead of using the default", () => {
      expect(() => loadConfig({ ...validEnv, SHUTDOWN_GRACE_MS: "30s" })).toThrow();
      expect(() => loadConfig({ ...validEnv, SHUTDOWN_DB_TIMEOUT_MS: "soon" })).toThrow();
    });

    it("rejects a zero, negative or fractional shutdown budget", () => {
      expect(() => loadConfig({ ...validEnv, SHUTDOWN_GRACE_MS: "0" })).toThrow();
      expect(() => loadConfig({ ...validEnv, SHUTDOWN_GRACE_MS: "-1" })).toThrow();
      expect(() => loadConfig({ ...validEnv, SHUTDOWN_DB_TIMEOUT_MS: "1.5" })).toThrow();
    });

    it("defaults staticDir to the path a source checkout produces", () => {
      expect(loadConfig(validEnv).staticDir).toBe("../web/dist");
    });

    it("reads a STATIC_DIR override and treats an empty one as absent", () => {
      expect(loadConfig({ ...validEnv, STATIC_DIR: "/app/apps/web/dist" }).staticDir).toBe(
        "/app/apps/web/dist",
      );
      expect(loadConfig({ ...validEnv, STATIC_DIR: "" }).staticDir).toBe("../web/dist");
    });
  });

  // GH #259: the same defect one variable later. METRICS_TOKEN was read
  // straight from process.env inside createApp, so it never passed through
  // here — and a misspelled name produced a 404 indistinguishable from
  // "metrics deliberately off", which is how monitoring disappears unnoticed.
  describe("METRICS_TOKEN", () => {
    it("is absent by default, which is what leaves /metrics unregistered", () => {
      expect(loadConfig(validEnv).metricsToken).toBeUndefined();
    });

    it("reads METRICS_TOKEN", () => {
      expect(loadConfig({ ...validEnv, METRICS_TOKEN: "scrape-token" }).metricsToken).toBe(
        "scrape-token",
      );
    });

    it("treats an empty or whitespace-only token as absent, never as a secret", () => {
      expect(loadConfig({ ...validEnv, METRICS_TOKEN: "" }).metricsToken).toBeUndefined();
      expect(loadConfig({ ...validEnv, METRICS_TOKEN: "   " }).metricsToken).toBeUndefined();
    });

    it("trims a token that picked up whitespace from a compose file", () => {
      expect(loadConfig({ ...validEnv, METRICS_TOKEN: "  tok  " }).metricsToken).toBe("tok");
    });
  });

  // GH #235: the break-glass credential is the operator's to set now — the
  // process used to mint one and print it to the log stream in plaintext.
  describe("BOOTSTRAP_PASSWORD (GH #235)", () => {
    it("refuses to boot with BOOTSTRAP_MODE=true and no credential", () => {
      expect(() => loadConfig({ ...validEnv, BOOTSTRAP_MODE: "true" })).toThrow(
        /BOOTSTRAP_PASSWORD/,
      );
    });

    it("refuses a credential shorter than the secret it replaces", () => {
      expect(() =>
        loadConfig({
          ...validEnv,
          BOOTSTRAP_MODE: "true",
          BOOTSTRAP_PASSWORD: "A".repeat(MIN_BOOTSTRAP_PASSWORD_LENGTH - 1),
        }),
      ).toThrow(/BOOTSTRAP_PASSWORD/);
    });

    it("accepts exactly the minimum length", () => {
      expect(
        loadConfig({ ...validEnv, BOOTSTRAP_MODE: "true", BOOTSTRAP_PASSWORD }).bootstrapPassword,
      ).toBe(BOOTSTRAP_PASSWORD);
    });

    it("does not require one — or reject a leftover one — with the mode off", () => {
      expect(loadConfig(validEnv).bootstrapPassword).toBeUndefined();
      expect(
        loadConfig({ ...validEnv, BOOTSTRAP_MODE: "false", BOOTSTRAP_PASSWORD: "short" })
          .bootstrapMode,
      ).toBe(false);
    });
  });
});
