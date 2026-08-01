import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client";
import { checkDb } from "./health";

// GH #228: this module measured 0% — the readiness probe's own liveness check
// had no test, so nothing pinned the one behaviour that matters about it: a
// failing database must come back as `false`, not as a thrown error that would
// turn a health endpoint into a 500.

/** Fake postgres client whose tagged-template call resolves or rejects. */
function fakeSql(result: Promise<unknown>): Db {
  return vi.fn(() => result) as unknown as Db;
}

describe("checkDb", () => {
  it("returns true when the probe query succeeds", async () => {
    await expect(checkDb(fakeSql(Promise.resolve([{ "?column?": 1 }])))).resolves.toBe(true);
  });

  it("returns false instead of throwing when the database is unreachable", async () => {
    const err = Object.assign(new Error("transport ECONNREFUSED"), { code: "ECONNREFUSED" });
    await expect(checkDb(fakeSql(Promise.reject(err)))).resolves.toBe(false);
  });

  it("returns false on a server-side query error too", async () => {
    const err = Object.assign(new Error("canceling statement"), { code: "57014" });
    await expect(checkDb(fakeSql(Promise.reject(err)))).resolves.toBe(false);
  });

  it("issues a single trivial probe query", async () => {
    const sql = vi.fn(() => Promise.resolve([{ "?column?": 1 }]));
    await checkDb(sql as unknown as Db);
    expect(sql).toHaveBeenCalledTimes(1);
    const [strings] = sql.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(strings.join("").trim()).toBe("select 1");
  });
});
