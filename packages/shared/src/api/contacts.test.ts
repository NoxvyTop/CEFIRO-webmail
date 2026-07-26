import { describe, expect, it } from "vitest";
import { contactSchema, contactInputSchema } from "./contacts";

describe("contactSchema", () => {
  it("parses a manual contact", () => {
    const result = contactSchema.parse({
      id: "c-1",
      name: "Ana",
      email: "ana@noxvytop.com",
      source: "manual",
    });
    expect(result).toEqual({
      id: "c-1",
      name: "Ana",
      email: "ana@noxvytop.com",
      source: "manual",
    });
  });

  it("parses a harvested contact", () => {
    const result = contactSchema.parse({
      id: "c-2",
      name: "",
      email: "bob@noxvytop.com",
      source: "harvested",
    });
    expect(result.source).toBe("harvested");
  });

  it("rejects an unknown source", () => {
    const result = contactSchema.safeParse({
      id: "c-3",
      name: "Ana",
      email: "ana@noxvytop.com",
      source: "imported",
    });
    expect(result.success).toBe(false);
  });
});

describe("contactInputSchema", () => {
  it("defaults name to an empty string when omitted", () => {
    const result = contactInputSchema.parse({ email: "ana@noxvytop.com" });
    expect(result.name).toBe("");
  });

  it("trims a provided name", () => {
    const result = contactInputSchema.parse({ name: "  Ana  ", email: "ana@noxvytop.com" });
    expect(result.name).toBe("Ana");
  });

  it("rejects a malformed email", () => {
    const result = contactInputSchema.safeParse({ name: "Ana", email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing email", () => {
    const result = contactInputSchema.safeParse({ name: "Ana" });
    expect(result.success).toBe(false);
  });
});
