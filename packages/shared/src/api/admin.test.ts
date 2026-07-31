import { describe, expect, it } from "vitest";
import {
  ADMIN_USERS_PAGE_SIZE_DEFAULT, ADMIN_USERS_PAGE_SIZE_MAX,
  adminUserSchema, adminUsersPageSchema, adminUsersQuerySchema,
  createUserInputSchema, instanceSettingsViewSchema, updateInstanceSettingsSchema,
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

  // GH #153: server-side pagination contract.
  it("adminUsersQuerySchema coerces string params and applies defaults", () => {
    const parsed = adminUsersQuerySchema.parse({ page: "2", pageSize: "10", search: "  alice  " });
    expect(parsed).toEqual({ page: 2, pageSize: 10, search: "alice" });

    const defaults = adminUsersQuerySchema.parse({});
    expect(defaults.page).toBe(1);
    expect(defaults.pageSize).toBe(ADMIN_USERS_PAGE_SIZE_DEFAULT);
    expect(defaults.search).toBeUndefined();
  });

  it("adminUsersQuerySchema clamps out-of-range page/pageSize and falls back on junk", () => {
    const clamped = adminUsersQuerySchema.parse({ page: "0", pageSize: "1000" });
    expect(clamped.page).toBe(1);
    expect(clamped.pageSize).toBe(ADMIN_USERS_PAGE_SIZE_MAX);

    const junk = adminUsersQuerySchema.parse({ page: "abc", pageSize: "xyz" });
    expect(junk.page).toBe(1);
    expect(junk.pageSize).toBe(ADMIN_USERS_PAGE_SIZE_DEFAULT);

    // An empty/whitespace search is treated as "no filter", not a match on "".
    expect(adminUsersQuerySchema.parse({ search: "   " }).search).toBeUndefined();
    // An over-long search is rejected.
    expect(() => adminUsersQuerySchema.parse({ search: "a".repeat(201) })).toThrow();
  });

  it("adminUsersPageSchema parses a page envelope with users, total, and stats", () => {
    const page = adminUsersPageSchema.parse({
      users: [
        {
          id: "1", email: "a@x.com", displayName: "A", role: "admin",
          locale: "es", active: true, mailboxLinked: false,
        },
      ],
      total: 42,
      stats: { total: 42, active: 40, mailboxLinked: 30 },
    });
    expect(page.users).toHaveLength(1);
    expect(page.total).toBe(42);
    expect(page.stats).toEqual({ total: 42, active: 40, mailboxLinked: 30 });
  });
});
