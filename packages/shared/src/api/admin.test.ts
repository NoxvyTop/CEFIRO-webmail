import { describe, expect, it } from "vitest";
import {
  adminUserSchema, createUserInputSchema, instanceSettingsViewSchema, updateInstanceSettingsSchema,
} from "./admin";

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
  // GH #130: adminUserSchema must carry the user's avatar so the admin UI
  // can render it. avatarDataUrl is optional+nullable — optional so older
  // payloads (and existing fixtures without the field) still validate,
  // nullable for users with no photo.
  it("parses an admin user with an avatarDataUrl", () => {
    const u = adminUserSchema.parse({
      id: "1",
      email: "a@x.com",
      displayName: "A",
      role: "admin",
      locale: "es",
      active: true,
      mailboxLinked: false,
      avatarDataUrl: "data:image/png;base64,aGVsbG8=",
    });
    expect(u.avatarDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });
  it("parses an admin user without an avatarDataUrl (absent or null)", () => {
    const withoutField = adminUserSchema.parse({
      id: "1",
      email: "a@x.com",
      displayName: "A",
      role: "admin",
      locale: "es",
      active: true,
      mailboxLinked: false,
    });
    expect(withoutField.avatarDataUrl).toBeUndefined();

    const withNull = adminUserSchema.parse({
      id: "1",
      email: "a@x.com",
      displayName: "A",
      role: "admin",
      locale: "es",
      active: true,
      mailboxLinked: false,
      avatarDataUrl: null,
    });
    expect(withNull.avatarDataUrl).toBeNull();
  });
  it("createUserInput defaults role/locale and validates email", () => {
    const parsed = createUserInputSchema.parse({ email: "a@x.com", displayName: "A" });
    expect(parsed.role).toBe("employee");
    expect(parsed.locale).toBe("es");
    expect(() => createUserInputSchema.parse({ email: "nope", displayName: "A" })).toThrow();
  });
  it("instanceSettingsViewSchema and updateInstanceSettingsSchema require a boolean sentWithFooter", () => {
    expect(instanceSettingsViewSchema.parse({ sentWithFooter: false })).toEqual({ sentWithFooter: false });
    expect(updateInstanceSettingsSchema.parse({ sentWithFooter: true })).toEqual({ sentWithFooter: true });
    expect(() => updateInstanceSettingsSchema.parse({ sentWithFooter: "yes" })).toThrow();
  });
});
