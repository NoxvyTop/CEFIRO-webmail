import type { ProfileView } from "@webmail/shared";
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

// Neutralize LIKE wildcards so a literal `%` or `_` typed into the admin
// search box matches itself instead of acting as a pattern. Paired with an
// explicit `ESCAPE '\'` clause on every ilike below.
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ProfileView comes from @webmail/shared (packages/shared/src/api/profile.ts)
// rather than being redefined here — it's structurally identical to the
// zod-inferred shared type and apps/server already imports other shared
// types/schemas elsewhere with no reverse dependency (shared has no
// dependency on apps/server, so there's no import cycle risk).
//
// Kept separate from UserRecord/toRecord: /api/auth/me and other hot paths
// return UserRecord-shaped payloads and must NOT carry the (potentially
// large, base64-encoded) avatar. Only the dedicated profile endpoints read
// this shape.

type ProfileRow = {
  display_name: string;
  email: string;
  avatar_data_url: string | null;
};

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
    // Dedicated to the admin users list (GET /api/admin/users). GH #205: the
    // list no longer ships each avatar inline (a base64 data URL that made the
    // payload grow with every user and defeated HTTP caching). It selects only
    // a `has_avatar` flag; the console loads each photo separately from the
    // cacheable avatar endpoint, so this query never reads the (potentially ~1
    // MiB) avatar bytes out of the DB.
    //
    // Two query variants rather than a composed `where` fragment on purpose:
    // the db-client wrapper (infra/db/client.ts) eagerly executes any nested
    // tagged-template, so fragments cannot be interpolated here.
    async listPage(opts: {
      limit: number;
      offset: number;
      search?: string;
    }): Promise<(UserRecord & { hasAvatar: boolean })[]> {
      const rows = opts.search
        ? await sql<(UserRow & { has_avatar: boolean })[]>`
            select id, email, display_name, role, locale, active,
                   avatar_data_url is not null as has_avatar
            from users
            where email ilike ${`%${escapeLike(opts.search)}%`} escape '\\'
               or display_name ilike ${`%${escapeLike(opts.search)}%`} escape '\\'
            order by active desc, email asc
            limit ${opts.limit} offset ${opts.offset}
          `
        : await sql<(UserRow & { has_avatar: boolean })[]>`
            select id, email, display_name, role, locale, active,
                   avatar_data_url is not null as has_avatar
            from users
            order by active desc, email asc
            limit ${opts.limit} offset ${opts.offset}
          `;
      return rows.map((row) => ({ ...toRecord(row), hasAvatar: row.has_avatar }));
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
    // Active-user count for the Resumen dashboard (GH #153) — kept aggregate so
    // the metric never depends on which page of users the admin is viewing.
    async countActive(): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from users where active = true
      `;
      return Number(rows[0]!.count);
    },
    // Total users matching the same email/name filter as listPage — this is
    // what drives the pager's total. Mirrors that method's two-variant shape
    // for the same db-client-wrapper reason.
    async countMatching(search?: string): Promise<number> {
      const rows = search
        ? await sql<{ count: string }[]>`
            select count(*)::text as count from users
            where email ilike ${`%${escapeLike(search)}%`} escape '\\'
               or display_name ilike ${`%${escapeLike(search)}%`} escape '\\'
          `
        : await sql<{ count: string }[]>`select count(*)::text as count from users`;
      return Number(rows[0]!.count);
    },
    async countActiveAdmins(): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from users where role = 'admin' and active = true
      `;
      return Number(rows[0]!.count);
    },
    async setDisplayName(id: string, displayName: string): Promise<void> {
      await sql`update users set display_name = ${displayName} where id = ${id}`;
    },
    async setAvatar(id: string, dataUrl: string | null): Promise<void> {
      await sql`update users set avatar_data_url = ${dataUrl} where id = ${id}`;
    },
    // GH #205: the raw avatar data URL for one user, backing the cacheable
    // avatar endpoints. Returns null when the user has no photo (or does not
    // exist); either way the endpoint responds 404.
    async getAvatar(id: string): Promise<string | null> {
      const rows = await sql<{ avatar_data_url: string | null }[]>`
        select avatar_data_url from users where id = ${id}
      `;
      return rows[0]?.avatar_data_url ?? null;
    },
    // GH #205: cheap existence check used to build the `avatarUrl` on
    // single-user admin responses without reading the avatar bytes.
    async hasAvatar(id: string): Promise<boolean> {
      const rows = await sql<{ has_avatar: boolean }[]>`
        select avatar_data_url is not null as has_avatar from users where id = ${id}
      `;
      return rows[0]?.has_avatar ?? false;
    },
    async getProfile(id: string): Promise<ProfileView | null> {
      const rows = await sql<ProfileRow[]>`
        select display_name, email, avatar_data_url from users where id = ${id}
      `;
      const row = rows[0];
      if (!row) return null;
      return { displayName: row.display_name, email: row.email, avatarDataUrl: row.avatar_data_url };
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
