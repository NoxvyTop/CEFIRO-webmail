import { describe, expect, it } from "vitest";
import { adminUserSchema, createUserInputSchema } from "./admin";

describe("admin contracts", () => {
  it("parses an admin user with mailboxLinked", () => {
    const u = adminUserSchema.parse({
      id: "1",
      email: "a@x.com",
      displayName: "A",
      role: "admin",
      locale: "es",
      active: true,
      mailboxLinked: false,
    });
    expect(u.mailboxLinked).toBe(false);
  });
  it("createUserInput defaults role/locale and validates email", () => {
    const parsed = createUserInputSchema.parse({ email: "a@x.com", displayName: "A" });
    expect(parsed.role).toBe("employee");
    expect(parsed.locale).toBe("es");
    expect(() => createUserInputSchema.parse({ email: "nope", displayName: "A" })).toThrow();
  });
});
