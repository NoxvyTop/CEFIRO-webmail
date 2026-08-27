import { describe, expect, it } from "vitest";
import {
  DRAFT_CONTEXT_MAX_CHARS,
  DRAFT_INTENT_MAX_CHARS,
  DRAFT_SUBJECT_MAX_CHARS,
  aiStatusSchema,
  draftInputSchema,
  draftResultSchema,
  summaryResultSchema,
} from "./ai";

describe("ai contracts", () => {
  // GH #304: the draft is driven by the required `intent`; the subject is an
  // optional hint now, not the primary instruction.
  it("accepts a valid draft input with only an intent", () => {
    const parsed = draftInputSchema.parse({ intent: "no voy el 20 de agosto" });
    expect(parsed.intent).toBe("no voy el 20 de agosto");
    expect(parsed.subject).toBeUndefined();
    expect(parsed.context).toBeUndefined();
  });

  it("rejects a draft input with an empty intent", () => {
    expect(() => draftInputSchema.parse({ intent: "" })).toThrow();
  });

  it("rejects a draft input missing the intent entirely", () => {
    expect(() => draftInputSchema.parse({ subject: "Reunión" })).toThrow();
  });

  it("accepts an intent exactly at the length cap and rejects one over it", () => {
    expect(
      draftInputSchema.parse({ intent: "a".repeat(DRAFT_INTENT_MAX_CHARS) }).intent,
    ).toHaveLength(DRAFT_INTENT_MAX_CHARS);
    expect(() => draftInputSchema.parse({ intent: "a".repeat(DRAFT_INTENT_MAX_CHARS + 1) })).toThrow();
  });

  // GH #304: the subject is an optional weak hint, capped.
  it("accepts an optional subject hint and rejects one over the length cap", () => {
    const parsed = draftInputSchema.parse({ intent: "aviso que no voy", subject: "Reunión" });
    expect(parsed.subject).toBe("Reunión");
    expect(() =>
      draftInputSchema.parse({ intent: "x", subject: "a".repeat(DRAFT_SUBJECT_MAX_CHARS + 1) }),
    ).toThrow();
  });

  // GH #299: the original message body travels as optional `context`, capped to
  // bound provider cost.
  it("accepts a draft input carrying an optional context", () => {
    const parsed = draftInputSchema.parse({ intent: "confirmo", context: "¿Confirmas el total?" });
    expect(parsed.context).toBe("¿Confirmas el total?");
  });

  it("accepts a context exactly at the length cap", () => {
    const parsed = draftInputSchema.parse({ intent: "x", context: "a".repeat(DRAFT_CONTEXT_MAX_CHARS) });
    expect(parsed.context).toHaveLength(DRAFT_CONTEXT_MAX_CHARS);
  });

  it("rejects a context over the length cap", () => {
    expect(() =>
      draftInputSchema.parse({ intent: "x", context: "a".repeat(DRAFT_CONTEXT_MAX_CHARS + 1) }),
    ).toThrow();
  });

  it("accepts a valid draft result", () => {
    const parsed = draftResultSchema.parse({ body: "Estimado equipo..." });
    expect(parsed.body).toBe("Estimado equipo...");
  });

  it("accepts a valid summary result with exactly 3 bullets", () => {
    const parsed = summaryResultSchema.parse({ bullets: ["a", "b", "c"] });
    expect(parsed.bullets).toHaveLength(3);
  });

  it("parses an ai status flag and rejects a non-boolean", () => {
    expect(aiStatusSchema.parse({ enabled: true }).enabled).toBe(true);
    expect(aiStatusSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(() => aiStatusSchema.parse({ enabled: "yes" })).toThrow();
  });
});
