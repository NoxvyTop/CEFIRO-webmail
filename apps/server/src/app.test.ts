import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "@webmail/shared";
import { createApp } from "./app";

describe("app", () => {
  it("returns health with a trace header", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-trace-id")).toBeTruthy();
    expect(healthResponseSchema.parse(await res.json()).status).toBe("ok");
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await createApp().request("/api/nope");
    expect(res.status).toBe(404);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.code).toBe("not_found");
    expect(body.message).toBe("errors.not_found");
  });
});
