import { describe, expect, it } from "vitest";
import { activeSessionListSchema, activeSessionSchema } from "./sessions";

const validSession = {
  id: "sha256-row-handle",
  current: true,
  userAgent: "Mozilla/5.0",
  ip: "203.0.113.7",
  createdAt: "2026-08-04T10:00:00.000Z",
  lastSeenAt: "2026-08-04T12:00:00.000Z",
  expiresAt: "2026-08-04T22:00:00.000Z",
};

describe("active session contracts (#302)", () => {
  it("accepts a full active session", () => {
    const parsed = activeSessionSchema.parse(validSession);
    expect(parsed.id).toBe("sha256-row-handle");
    expect(parsed.current).toBe(true);
  });

  it("accepts null userAgent and ip (unattributed metadata)", () => {
    expect(() =>
      activeSessionSchema.parse({ ...validSession, userAgent: null, ip: null }),
    ).not.toThrow();
  });

  it("rejects a session missing the current flag", () => {
    const { current: _drop, ...withoutCurrent } = validSession;
    expect(() => activeSessionSchema.parse(withoutCurrent)).toThrow();
  });

  it("rejects a non-string id", () => {
    expect(() => activeSessionSchema.parse({ ...validSession, id: 123 })).toThrow();
  });

  it("parses a list of sessions preserving each current flag", () => {
    const list = activeSessionListSchema.parse([
      validSession,
      { ...validSession, id: "other", current: false },
    ]);
    expect(list).toHaveLength(2);
    expect(list[1]?.current).toBe(false);
  });
});
