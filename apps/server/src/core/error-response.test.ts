import { describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";
import { apiErrorSchema } from "@webmail/shared";
import { errorResponse } from "./error-response";

type LogLine = Record<string, unknown>;

type Env = { Variables: { traceId: string } };

function appReturning(
  build: (c: Context<Env>) => Response,
  options: { traceId?: string } = { traceId: "trace-1" },
) {
  const app = new Hono<Env>();
  if (options.traceId !== undefined) {
    app.use("*", async (c, next) => {
      c.set("traceId", options.traceId!);
      await next();
    });
  }
  app.get("/x", (c) => build(c));
  return app;
}

async function captureLogs(run: () => Response | Promise<Response>) {
  const lines: LogLine[] = [];
  const record = (...args: unknown[]) => {
    lines.push(JSON.parse(String(args[0])) as LogLine);
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
  ];
  try {
    return { res: await run(), lines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("errorResponse", () => {
  it("returns the api error envelope with the trace id and the default message key", async () => {
    const app = appReturning((c) => errorResponse(c, "invalid_body", 400));
    const res = await app.request("/x");
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      code: "invalid_body",
      message: "errors.invalid_body",
      traceId: "trace-1",
    });
  });

  it("uses an explicit message key when the code and the key differ", async () => {
    const app = appReturning((c) => errorResponse(c, "sieve_invalid", 502, "errors.custom_key"));
    const body = apiErrorSchema.parse(await (await app.request("/x")).json());
    expect(body).toMatchObject({ code: "sieve_invalid", message: "errors.custom_key" });
  });

  it("logs the code and the status at warn for a client error", async () => {
    const app = appReturning((c) => errorResponse(c, "not_found", 404));
    const { lines } = await captureLogs(() => app.request("/x"));
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "error response",
        code: "not_found",
        status: 404,
        traceId: "trace-1",
      }),
    );
  });

  it("logs at error for a server error", async () => {
    const app = appReturning((c) => errorResponse(c, "stalwart_unavailable", 502));
    const { lines } = await captureLogs(() => app.request("/x"));
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "error response",
        code: "stalwart_unavailable",
        status: 502,
      }),
    );
  });

  it("still produces a valid envelope when no trace id was set", async () => {
    const app = appReturning((c) => errorResponse(c, "internal", 500), { traceId: undefined });
    const body = apiErrorSchema.parse(await (await app.request("/x")).json());
    expect(body.traceId).toBe("unknown");
  });
});
