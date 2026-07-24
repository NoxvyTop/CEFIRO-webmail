import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const users = createUsersRepo(sql);

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("users repo — profile (display name + avatar)", () => {
  it("a freshly created user's avatar defaults to null via getProfile", async () => {
    const email = `p-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "Profile User" });
    const profile = await users.getProfile(created.id);
    expect(profile).toEqual({ displayName: "Profile User", email, avatarDataUrl: null });
  });

  it("setDisplayName updates the name and getProfile reflects it", async () => {
    const email = `p-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "Original Name" });
    await users.setDisplayName(created.id, "Updated Name");
    const profile = await users.getProfile(created.id);
    expect(profile?.displayName).toBe("Updated Name");
  });

  it("setAvatar persists a data URL and can clear it back to null", async () => {
    const email = `p-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "Avatar User" });
    const dataUrl = "data:image/png;base64,aGVsbG8=";

    await users.setAvatar(created.id, dataUrl);
    expect((await users.getProfile(created.id))?.avatarDataUrl).toBe(dataUrl);

    await users.setAvatar(created.id, null);
    expect((await users.getProfile(created.id))?.avatarDataUrl).toBeNull();
  });

  it("setAvatar does not leak into findById's lean payload", async () => {
    const email = `p-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "Lean User" });
    await users.setAvatar(created.id, "data:image/png;base64,aGVsbG8=");
    const found = await users.findById(created.id);
    expect(found).not.toHaveProperty("avatarDataUrl");
  });
});
