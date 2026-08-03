import { describe, expect, it } from "vitest";
import { aiStatusSchema, draftInputSchema, draftResultSchema, summaryResultSchema } from "./ai";

describe("ai contracts", () => {
  it("accepts a valid draft input with only a subject", () => {
    const parsed = draftInputSchema.parse({ subject: "Reunión de seguimiento" });
    expect(parsed.subject).toBe("Reunión de seguimiento");
  });

  it("rejects a draft input with an empty subject", () => {
    expect(() => draftInputSchema.parse({ subject: "" })).toThrow();
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
