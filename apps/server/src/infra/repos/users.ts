import type { Db } from "../db/client";

export type UserRole = "employee" | "admin";

export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  locale: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  locale: string;
};

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    locale: row.locale,
  };
}

export function createUsersRepo(sql: Db) {
  return {
    async findByEmail(email: string): Promise<UserRecord | null> {
      const rows = await sql<UserRow[]>`
        select id, email, display_name, role, locale from users where email = ${email}
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async create(input: {
      email: string;
      displayName: string;
      role?: UserRole;
      locale?: string;
    }): Promise<UserRecord> {
      const rows = await sql<UserRow[]>`
        insert into users (email, display_name, role, locale)
        values (${input.email}, ${input.displayName}, ${input.role ?? "employee"}, ${input.locale ?? "es"})
        returning id, email, display_name, role, locale
      `;
      return toRecord(rows[0]!);
    },
    async count(): Promise<number> {
      const rows = await sql<{ count: string }[]>`select count(*)::text as count from users`;
      return Number(rows[0]!.count);
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
