import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "./envelope";

describe("apiErrorSchema", () => {
  it("accepts a valid error envelope", () => {
    const parsed = apiErrorSchema.parse({
      code: "not_found",
      message: "errors.not_found",
      traceId: "trace-1",
    });
    expect(parsed.code).toBe("not_found");
  });

  it("rejects an envelope without traceId", () => {
    expect(() =>
      apiErrorSchema.parse({ code: "x", message: "errors.x" }),
    ).toThrow();
  });
});

describe("healthResponseSchema", () => {
  it("accepts ok status with checks", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      checks: { postgres: true },
    });
    expect(parsed.checks.postgres).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(() =>
      healthResponseSchema.parse({ status: "broken", checks: {} }),
    ).toThrow();
  });
});
