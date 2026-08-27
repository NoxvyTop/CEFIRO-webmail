import type { Db } from "../../infra/db/client";
import type { ActiveSession, SessionUser } from "@webmail/shared";

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

type SessionMetaRow = {
  id: string;
  user_agent: string | null;
  ip: string | null;
  // postgres.js maps timestamptz to a Date; the API carries ISO strings so the
  // value a client parses never depends on the server's locale (same discipline
  // as the sieve-sync-state repo).
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

/** Best-effort metadata captured for a session at login (#302). */
export type SessionMeta = { userAgent?: string | null; ip?: string | null };

/** Options for the store. `idleMinutes` is the #301 sliding-timeout window. */
export type SessionStoreOptions = {
  /**
   * Idle / sliding-timeout window in minutes (#301). `null`/absent means no
   * idle limit — a session lives its full absolute `expires_at`, unchanged from
   * before this existed. When set, a session unused for longer than this is
   * treated as expired even though its absolute ceiling has not passed.
   */
  idleMinutes?: number | null;
};

export function createSessionStore(sql: Db, options: SessionStoreOptions = {}) {
  // Normalised once so the query binds a real NULL (→ "no idle limit") rather
  // than `undefined` when the knob is unset.
  const idleMinutes = options.idleMinutes ?? null;

  return {
    async create(
      userId: string,
      ttlHours: number,
      meta: SessionMeta = {},
    ): Promise<{ token: string; expiresAt: Date }> {
      const token = randomToken();
      const id = await hashToken(token);
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
      // Opportunistically purge expired rows so the table does not grow
      // unbounded; piggybacked on session creation to avoid extra infra.
      await sql`delete from sessions where expires_at < now()`;
      await sql`
        insert into sessions (id, user_id, expires_at, user_agent, ip)
        values (${id}, ${userId}, ${expiresAt}, ${meta.userAgent ?? null}, ${meta.ip ?? null})
      `;
      return { token, expiresAt };
    },
    async findUser(token: string): Promise<SessionUser | null> {
      const id = await hashToken(token);
      // One atomic statement does the expiry check, the idle check, AND the
      // sliding refresh (#301): the WHERE is evaluated against the row as it is
      // BEFORE the UPDATE, so the idle predicate reads the OLD `last_seen_at`,
      // and the same row is then stamped to `now()` — no read-then-write race.
      // `expires_at` is NEVER touched here: it is the absolute, non-extensible
      // ceiling, so a still-active-but-idle session past the idle window fails
      // the WHERE and is not refreshed. The idle clause is a no-op when
      // `idleMinutes` is null (`NULL::int is null` → the OR short-circuits true).
      const rows = await sql<SessionRow[]>`
        update sessions s
        set last_seen_at = now()
        from users u
        where s.id = ${id}
          and u.id = s.user_id
          and s.expires_at > now()
          and (
            ${idleMinutes}::int is null
            or s.last_seen_at > now() - make_interval(mins => ${idleMinutes}::int)
          )
        returning u.id as user_id, u.email, u.display_name, u.role, u.locale
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
    /**
     * The caller's own active (non-expired) sessions, newest activity first,
     * with the row that made THIS request flagged `current` (#302). The token
     * is never selected — only its hash (`id`), which is an opaque revoke handle.
     */
    async list(userId: string, currentToken: string): Promise<ActiveSession[]> {
      const currentId = await hashToken(currentToken);
      const rows = await sql<SessionMetaRow[]>`
        select id, user_agent, ip, created_at, last_seen_at, expires_at
        from sessions
        where user_id = ${userId} and expires_at > now()
        order by last_seen_at desc
      `;
      return rows.map((row) => ({
        id: row.id,
        current: row.id === currentId,
        userAgent: row.user_agent,
        ip: row.ip,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      }));
    },
    /**
     * Revoke ONE session by its id (#302). Scoped to `userId` so a caller can
     * only ever revoke their own — an id belonging to another user matches no
     * row. Returns whether a row was actually deleted.
     */
    async revokeById(userId: string, id: string): Promise<boolean> {
      const rows = await sql`
        delete from sessions where user_id = ${userId} and id = ${id} returning id
      `;
      return rows.length > 0;
    },
    /**
     * "Close every other session" (#302): revoke all of the user's sessions
     * except the one making the request. Returns how many were removed.
     */
    async revokeOthers(userId: string, currentToken: string): Promise<number> {
      const currentId = await hashToken(currentToken);
      const rows = await sql`
        delete from sessions where user_id = ${userId} and id <> ${currentId} returning id
      `;
      return rows.length;
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
