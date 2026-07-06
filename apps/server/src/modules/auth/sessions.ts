import type { Db } from "../../infra/db/client";
import type { SessionUser } from "@webmail/shared";

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function randomToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

type SessionRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: "employee" | "admin";
  locale: string;
};

export function createSessionStore(sql: Db) {
  return {
    async create(
      userId: string,
      ttlHours: number,
    ): Promise<{ token: string; expiresAt: Date }> {
      const token = randomToken();
      const id = await hashToken(token);
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
      await sql`
        insert into sessions (id, user_id, expires_at)
        values (${id}, ${userId}, ${expiresAt})
      `;
      return { token, expiresAt };
    },
    async findUser(token: string): Promise<SessionUser | null> {
      const id = await hashToken(token);
      const rows = await sql<SessionRow[]>`
        select u.id as user_id, u.email, u.display_name, u.role, u.locale
        from sessions s
        join users u on u.id = s.user_id
        where s.id = ${id} and s.expires_at > now()
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        locale: row.locale,
      };
    },
    async revoke(token: string): Promise<void> {
      const id = await hashToken(token);
      await sql`delete from sessions where id = ${id}`;
    },
    async revokeAllForUser(userId: string): Promise<number> {
      const rows = await sql`delete from sessions where user_id = ${userId} returning id`;
      return rows.length;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
