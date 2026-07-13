import type { Db } from "../db/client";

export type UserRole = "employee" | "admin";

export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  locale: string;
  active: boolean;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  locale: string;
  active: boolean;
};

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    locale: row.locale,
    active: row.active,
  };
}

export function createUsersRepo(sql: Db) {
  return {
    async findByEmail(email: string): Promise<UserRecord | null> {
      const rows = await sql<UserRow[]>`
        select id, email, display_name, role, locale, active
        from users where email = ${email.toLowerCase()}
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async findById(id: string): Promise<UserRecord | null> {
      const rows = await sql<UserRow[]>`
        select id, email, display_name, role, locale, active
        from users where id = ${id}
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
        values (${input.email.toLowerCase()}, ${input.displayName}, ${input.role ?? "employee"}, ${input.locale ?? "es"})
        returning id, email, display_name, role, locale, active
      `;
      return toRecord(rows[0]!);
    },
    async list(): Promise<UserRecord[]> {
      const rows = await sql<UserRow[]>`
        select id, email, display_name, role, locale, active
        from users order by active desc, email asc
      `;
      return rows.map(toRecord);
    },
    async setRole(id: string, role: UserRole): Promise<UserRecord | null> {
      const rows = await sql<UserRow[]>`
        update users set role = ${role} where id = ${id}
        returning id, email, display_name, role, locale, active
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async setActive(id: string, active: boolean): Promise<UserRecord | null> {
      const rows = await sql<UserRow[]>`
        update users set active = ${active} where id = ${id}
        returning id, email, display_name, role, locale, active
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async count(): Promise<number> {
      const rows = await sql<{ count: string }[]>`select count(*)::text as count from users`;
      return Number(rows[0]!.count);
    },
    async countActiveAdmins(): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from users where role = 'admin' and active = true
      `;
      return Number(rows[0]!.count);
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
