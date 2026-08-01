import { describe, expect, it } from "vitest";
import { AUTH_ERROR_CODES, authModeSchema, bootstrapLoginSchema } from "./auth";

describe("auth mode + bootstrap login contracts", () => {
  it("authModeSchema parses a boolean flag", () => {
    expect(authModeSchema.parse({ bootstrapMode: true }).bootstrapMode).toBe(true);
    expect(() => authModeSchema.parse({ bootstrapMode: "yes" })).toThrow();
  });
  it("bootstrapLoginSchema requires non-empty email and password", () => {
    expect(bootstrapLoginSchema.parse({ email: "bootstrap-admin", password: "p" }).email).toBe(
      "bootstrap-admin",
    );
    expect(() => bootstrapLoginSchema.parse({ email: "", password: "p" })).toThrow();
    expect(() => bootstrapLoginSchema.parse({ email: "x", password: "" })).toThrow();
  });
});

// GH #232. This list is the whole reason the two sides cannot drift: the server
// redirects through it, the login screen looks up a message for each entry.
describe("AUTH_ERROR_CODES", () => {
  it("carries the causes the login screen has to answer for", () => {
    expect([...AUTH_ERROR_CODES]).toEqual([
      "state",
      "account_archived",
      "oidc_email_unverified",
      "oidc",
    ]);
  });

  it("holds no duplicates and nothing that would need escaping in a query string", () => {
    expect(new Set(AUTH_ERROR_CODES).size).toBe(AUTH_ERROR_CODES.length);
    for (const code of AUTH_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
