import { describe, expect, it } from "vitest";
import {
  DRAFT_CONTEXT_MAX_CHARS,
  aiStatusSchema,
  draftInputSchema,
  draftResultSchema,
  summaryResultSchema,
} from "./ai";

describe("ai contracts", () => {
  it("accepts a valid draft input with only a subject", () => {
    const parsed = draftInputSchema.parse({ subject: "Reunión de seguimiento" });
    expect(parsed.subject).toBe("Reunión de seguimiento");
    expect(parsed.context).toBeUndefined();
  });

  it("rejects a draft input with an empty subject", () => {
    expect(() => draftInputSchema.parse({ subject: "" })).toThrow();
  });

  // GH #299: the original message body travels as optional `context`, capped to
  // bound provider cost.
  it("accepts a draft input carrying an optional context", () => {
    const parsed = draftInputSchema.parse({ subject: "Re: Pedido", context: "¿Confirmas el total?" });
    expect(parsed.context).toBe("¿Confirmas el total?");
  });

  it("accepts a context exactly at the length cap", () => {
    const parsed = draftInputSchema.parse({ subject: "Re: X", context: "a".repeat(DRAFT_CONTEXT_MAX_CHARS) });
    expect(parsed.context).toHaveLength(DRAFT_CONTEXT_MAX_CHARS);
  });

  it("rejects a context over the length cap", () => {
    expect(() =>
      draftInputSchema.parse({ subject: "Re: X", context: "a".repeat(DRAFT_CONTEXT_MAX_CHARS + 1) }),
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
