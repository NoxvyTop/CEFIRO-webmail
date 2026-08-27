import { describe, expect, it } from "vitest";
import { setupSsoSchema, setupStatusSchema, setupUserSchema } from "./setup";

// The bootstrap contracts: what the first-run wizard is allowed to send when it
// configures SSO and mints the first accounts. Both inputs cross a privilege
// boundary — one stores an OIDC client secret, the other can create an admin —
// so the defaults and the minimums below are the parts worth pinning.
// GH #229: packages/shared had no coverage gate and this module had no tests.

const SSO = {
  issuer: "https://id.example.com",
  clientId: "cefiro",
  clientSecret: "s3cret",
};

describe("setupSsoSchema", () => {
  it("defaults scopes to the OIDC set the app needs", () => {
    expect(setupSsoSchema.parse(SSO)).toEqual({ ...SSO, scopes: "openid profile email" });
  });

  it("keeps an explicit scopes string", () => {
    expect(setupSsoSchema.parse({ ...SSO, scopes: "openid email" }).scopes).toBe("openid email");
  });

  it("requires the issuer to be a URL", () => {
    expect(() => setupSsoSchema.parse({ ...SSO, issuer: "id.example.com" })).toThrow();
    expect(() => setupSsoSchema.parse({ ...SSO, issuer: "" })).toThrow();
  });

  it("rejects an empty clientId, clientSecret or scopes", () => {
    expect(() => setupSsoSchema.parse({ ...SSO, clientId: "" })).toThrow();
    expect(() => setupSsoSchema.parse({ ...SSO, clientSecret: "" })).toThrow();
    expect(() => setupSsoSchema.parse({ ...SSO, scopes: "" })).toThrow();
  });
});

const USER = {
  email: "carlos@example.com",
  displayName: "Carlos",
  mailPassword: "hunter2hunter2",
};

describe("setupUserSchema", () => {
  it("defaults a new account to the employee role and the Spanish locale", () => {
    expect(setupUserSchema.parse(USER)).toEqual({ ...USER, role: "employee", locale: "es" });
  });

  it("accepts admin as an explicit role and rejects anything else", () => {
    expect(setupUserSchema.parse({ ...USER, role: "admin" }).role).toBe("admin");
    expect(() => setupUserSchema.parse({ ...USER, role: "superuser" })).toThrow();
  });

  it("requires a valid email and a non-empty displayName", () => {
    expect(() => setupUserSchema.parse({ ...USER, email: "carlos" })).toThrow();
    expect(() => setupUserSchema.parse({ ...USER, displayName: "" })).toThrow();
  });

  it("enforces a minimum mail password length of 8", () => {
    expect(() => setupUserSchema.parse({ ...USER, mailPassword: "1234567" })).toThrow();
    expect(setupUserSchema.parse({ ...USER, mailPassword: "12345678" }).mailPassword).toBe("12345678");
  });

  it("requires a locale of at least two characters", () => {
    expect(() => setupUserSchema.parse({ ...USER, locale: "e" })).toThrow();
    expect(setupUserSchema.parse({ ...USER, locale: "en" }).locale).toBe("en");
  });
});

describe("setupStatusSchema", () => {
  it("parses the wizard's status payload", () => {
    const status = { bootstrapMode: true, ssoConfigured: false, userCount: 0 };
    expect(setupStatusSchema.parse(status)).toEqual(status);
  });

  it("rejects a non-boolean flag or a non-numeric count", () => {
    expect(() =>
      setupStatusSchema.parse({ bootstrapMode: "true", ssoConfigured: false, userCount: 0 }),
    ).toThrow();
    expect(() =>
      setupStatusSchema.parse({ bootstrapMode: true, ssoConfigured: false, userCount: "0" }),
    ).toThrow();
  });
});
