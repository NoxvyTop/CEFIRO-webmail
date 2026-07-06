import { describe, expect, it } from "vitest";
import { authModeSchema, bootstrapLoginSchema } from "./auth";

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
