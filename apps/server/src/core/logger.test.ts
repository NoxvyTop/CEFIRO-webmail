import { afterEach, describe, expect, it, vi } from "vitest";
import { log, withLogContext } from "./logger";

type LogLine = Record<string, unknown>;

/** Collects the JSON lines the logger writes while `run` executes. */
function captureLogs(run: () => void): LogLine[] {
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
    run();
    return lines;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const originalLevel = process.env.LOG_LEVEL;

afterEach(() => {
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

describe("log level (GH #219)", () => {
  it("writes info and above by default, and drops debug", () => {
    delete process.env.LOG_LEVEL;
    const lines = captureLogs(() => {
      log("debug", "noisy");
      log("info", "ordinary");
      log("warn", "notable");
      log("error", "broken");
    });
    expect(lines.map((line) => line.msg)).toEqual(["ordinary", "notable", "broken"]);
  });

  it("drops everything below the configured LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    const lines = captureLogs(() => {
      log("debug", "noisy");
      log("info", "ordinary");
      log("warn", "notable");
    });
    expect(lines.map((line) => line.msg)).toEqual(["notable"]);
  });

  it("admits debug when asked for it, whatever the casing", () => {
    process.env.LOG_LEVEL = " DEBUG ";
    const lines = captureLogs(() => log("debug", "noisy"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "debug", msg: "noisy" });
  });

  it("falls back to the default rather than silencing the server on a bad value", () => {
    process.env.LOG_LEVEL = "verbose";
    const lines = captureLogs(() => {
      log("debug", "noisy");
      log("info", "ordinary");
    });
    expect(lines.map((line) => line.msg)).toEqual(["ordinary"]);
  });
});

describe("log context (GH #219)", () => {
  it("adds the ambient fields to every line written inside the context", () => {
    const lines = captureLogs(() => {
      withLogContext({ traceId: "trace-1" }, () => {
        log("warn", "upstream timed out", { upstream: "stalwart" });
      });
    });
    expect(lines[0]).toMatchObject({
      msg: "upstream timed out",
      upstream: "stalwart",
      traceId: "trace-1",
    });
  });

  it("lets an explicit field win over the ambient one", () => {
    const lines = captureLogs(() => {
      withLogContext({ traceId: "ambient" }, () => {
        log("info", "request", { traceId: "explicit" });
      });
    });
    expect(lines[0]!.traceId).toBe("explicit");
  });

  it("leaves lines written outside any context untouched", () => {
    const lines = captureLogs(() => log("info", "server started", { port: 8080 }));
    expect(lines[0]).toMatchObject({ msg: "server started", port: 8080 });
    expect(lines[0]!.traceId).toBeUndefined();
  });

  it("does not leak one context into another", async () => {
    const lines: LogLine[] = [];
    const record = (...args: unknown[]) => {
      lines.push(JSON.parse(String(args[0])) as LogLine);
    };
    const spy = vi.spyOn(console, "log").mockImplementation(record);
    try {
      await Promise.all([
        withLogContext({ traceId: "a" }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          log("info", "first");
        }),
        withLogContext({ traceId: "b" }, async () => {
          log("info", "second");
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toContainEqual(expect.objectContaining({ msg: "first", traceId: "a" }));
    expect(lines).toContainEqual(expect.objectContaining({ msg: "second", traceId: "b" }));
  });
});
