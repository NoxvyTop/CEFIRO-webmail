# F2 Plan 1/4 — Admin Portal Base & JIT Provisioning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees are auto-provisioned into the app on their first SSO login (JIT); an admin-only API manages users (list, proactive create, change role, archive/reactivate); archiving revokes the user's sessions immediately; archived users cannot log back in.

**Architecture:** Extends the F1 auth module. A new `active` column soft-deletes users. The OIDC callback stops denying unknown users and instead reconciles-or-creates the app-side row (JIT). A `requireAdmin` middleware composes over `requireSession`. Admin routes live in a new `modules/admin` router mounted at `/api/admin`. All admin actions are audited. See `docs/superpowers/specs/2026-07-06-phase2-admin-portal-design.md`.

**Tech Stack:** existing — Bun + Hono + TypeScript, postgres.js, Zod, Vitest. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; conventional commits; no AI attribution; no compiled `.js` committed (`.gitignore` guards `apps/**/src/**/*.js`).
- TDD per task: write the test, run it and SEE IT FAIL (capture output), implement, see it pass; both outputs in the report.
- Runtime-agnostic backend: Web APIs only in `modules/` and `core/`; Bun-only APIs confined to `src/index.ts`.
- Error envelope is uniform `{ code, message, traceId }` with `message` an i18n key.
- Secrets and mail content never logged; admin actions audited via the existing `audit_log` (never mail content).
- Migrations are additive only; existing F1 tests must stay green.
- Postgres for integration tests: dev container stack on host port 5434, `DATABASE_URL` fallback `postgres://webmail:webmail@localhost:5434/webmail`.
- NEVER kill processes globally (`taskkill /IM ...`); kill only PIDs you started; prefer running inside the dev container.
- Every task runs `bun run typecheck` and its tests before committing.
- Branch: `init-admin-portal`.

---

### Task 1: Add `users.active` column (migration + repo)

**Files:**
- Create: `apps/server/migrations/0002_users_active.sql`
- Modify: `apps/server/src/infra/repos/users.ts`
- Test: `apps/server/src/infra/repos/users-active.test.ts`

**Interfaces:**
- Consumes: `Db` from `infra/db/client`, existing `createUsersRepo`.
- Produces: `UserRecord` gains `active: boolean`. New repo methods:
  - `findByEmail(email)` — unchanged signature, now also returns `active`.
  - `list(): Promise<UserRecord[]>` — all users, active first then email.
  - `setRole(id, role): Promise<UserRecord | null>` — null when not found.
  - `setActive(id, active): Promise<UserRecord | null>` — null when not found.
  - `createUsersRepo` gains these; `create` and `count` unchanged.

- [ ] **Step 1: Write the migration** — `apps/server/migrations/0002_users_active.sql`

```sql
alter table users add column active boolean not null default true;
create index users_active_idx on users (active);
```

- [ ] **Step 2: Write the failing test** — `apps/server/src/infra/repos/users-active.test.ts`

```ts
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

describe("users repo — active + admin ops", () => {
  it("new users are active and findByEmail returns active", async () => {
    const email = `a-${crypto.randomUUID()}@noxvytop.com`;
    const created = await users.create({ email, displayName: "A" });
    expect(created.active).toBe(true);
    expect((await users.findByEmail(email))?.active).toBe(true);
  });

  it("setActive archives and reactivates by id, null for missing", async () => {
    const user = await users.create({
      email: `b-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "B",
    });
    expect((await users.setActive(user.id, false))?.active).toBe(false);
    expect((await users.setActive(user.id, true))?.active).toBe(true);
    expect(await users.setActive(crypto.randomUUID(), false)).toBeNull();
  });

  it("setRole changes role by id, null for missing", async () => {
    const user = await users.create({
      email: `c-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "C",
    });
    expect((await users.setRole(user.id, "admin"))?.role).toBe("admin");
    expect(await users.setRole(crypto.randomUUID(), "admin")).toBeNull();
  });

  it("list returns users active-first", async () => {
    const all = await users.list();
    const firstInactiveIdx = all.findIndex((u) => !u.active);
    const lastActiveIdx = all.map((u) => u.active).lastIndexOf(true);
    if (firstInactiveIdx !== -1) expect(firstInactiveIdx).toBeGreaterThan(lastActiveIdx - 1);
    expect(Array.isArray(all)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/server && bunx vitest run src/infra/repos/users-active.test.ts`
Expected: FAIL — `created.active` is undefined / `setActive` not a function.

- [ ] **Step 4: Implement** — update `apps/server/src/infra/repos/users.ts`

Add `active` to `UserRecord`, `UserRow`, `toRecord`, and every `select` list; add the new methods:

```ts
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

const COLS = "id, email, display_name, role, locale, active";

export function createUsersRepo(sql: Db) {
  return {
    async findByEmail(email: string): Promise<UserRecord | null> {
      const rows = await sql<UserRow[]>`
        select id, email, display_name, role, locale, active
        from users where email = ${email.toLowerCase()}
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
  };
}
```

(The `COLS` constant is optional; explicit column lists inline also fine — keep whichever typechecks cleanly, matching the F1 style.)

- [ ] **Step 5: Run to verify it passes**

Run: `bunx vitest run src/infra/repos/users-active.test.ts`
Expected: 4 tests PASS. Also run `bunx vitest run src/infra/repos` — existing repo tests still green (they don't assert on `active`).

- [ ] **Step 6: Typecheck + commit**

```bash
cd apps/server && bun run typecheck
git add apps/server/migrations/0002_users_active.sql apps/server/src/infra/repos/users.ts apps/server/src/infra/repos/users-active.test.ts
git commit -m "feat(server): add users.active soft-delete column and admin repo ops"
```

---

### Task 2: Session store — revoke all sessions for a user

**Files:**
- Modify: `apps/server/src/modules/auth/sessions.ts`
- Test: `apps/server/src/modules/auth/sessions-revoke-all.test.ts`

**Interfaces:**
- Consumes: existing `createSessionStore(sql)`.
- Produces: new method `revokeAllForUser(userId: string): Promise<number>` — deletes every session row for the user, returns the count deleted.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/auth/sessions-revoke-all.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createSessionStore } from "./sessions";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("revokeAllForUser", () => {
  it("deletes every session of the user and returns the count", async () => {
    const user = await createUsersRepo(sql).create({
      email: `r-${crypto.randomUUID()}@noxvytop.com`,
      displayName: "R",
    });
    const a = await sessions.create(user.id, 1);
    const b = await sessions.create(user.id, 1);
    expect(await sessions.findUser(a.token)).not.toBeNull();

    const removed = await sessions.revokeAllForUser(user.id);
    expect(removed).toBe(2);
    expect(await sessions.findUser(a.token)).toBeNull();
    expect(await sessions.findUser(b.token)).toBeNull();
  });

  it("returns 0 when the user has no sessions", async () => {
    expect(await sessions.revokeAllForUser(crypto.randomUUID())).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bunx vitest run src/modules/auth/sessions-revoke-all.test.ts`
Expected: FAIL — `revokeAllForUser` is not a function.

- [ ] **Step 3: Implement** — add to the object returned by `createSessionStore` in `apps/server/src/modules/auth/sessions.ts`:

```ts
    async revokeAllForUser(userId: string): Promise<number> {
      const rows = await sql`delete from sessions where user_id = ${userId} returning id`;
      return rows.length;
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/modules/auth/sessions-revoke-all.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add apps/server/src/modules/auth/sessions.ts apps/server/src/modules/auth/sessions-revoke-all.test.ts
git commit -m "feat(server): add revokeAllForUser to session store"
```

---

### Task 3: JIT provisioning in the OIDC callback

**Files:**
- Modify: `apps/server/src/modules/auth/router.ts` (callback: replace unknown-user denial with JIT reconcile-or-create; block archived)
- Test: `apps/server/src/modules/auth/jit-provisioning.test.ts`

**Interfaces:**
- Consumes: `UsersRepo` (`findByEmail`, `create`), `AuditRepo`, `SessionStore` from earlier F1 code; `UserRecord.active` from Task 1.
- Produces: callback behavior — verified email with no row → create row (JIT), audit `user.jit_created`, issue session. Existing row, active → reuse, issue session. Existing row, archived → NO session, audit `login.denied_archived`, redirect `/?auth_error=account_archived`.

**Reconciliation contract (replaces current lines ~138-142 in `router.ts`):**

```ts
      const { email } = await verify(idToken);
      let user = await users.findByEmail(email);
      if (user && !user.active) {
        await audit.record({ actor: email, action: "login.denied_archived" });
        return c.redirect("/?auth_error=account_archived");
      }
      if (!user) {
        // JIT provisioning: first SSO login creates the app-side row.
        const displayName = email.split("@")[0] ?? email;
        user = await users.create({ email, displayName });
        await audit.record({ actor: email, action: "user.jit_created" });
      }
      const ttl = deps.sessionTtlHours ?? 12;
      const { token } = await deps.sessions.create(user.id, ttl);
      // ... setCookie + login.success audit unchanged ...
```

(`displayName` from the local-part is a placeholder the admin/user can refine later; if the OIDC verifier is later extended to expose `name`, use it — out of scope here. The verifier currently returns only `{ email }`.)

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/auth/jit-provisioning.test.ts`

Reuse the F1 login-flow test scaffolding pattern (`apps/server/src/modules/auth/login-flow.test.ts`): real Postgres for users/sessions/sso, a stubbed `OidcClient` whose `createVerifier` returns a controllable email. Cases:

```ts
// Pseudocode of the assertions — model the file on login-flow.test.ts.
// stubOidc.createVerifier returns () => ({ email: currentEmail })

it("creates the user on first login (JIT) and issues a session", async () => {
  currentEmail = `jit-${crypto.randomUUID()}@noxvytop.com`;
  // no users.create beforehand
  const { session } = await runLoginFlow(); // helper: /login then /callback, returns session cookie
  expect(session).toBeTruthy();
  expect(await createUsersRepo(sql).findByEmail(currentEmail)).not.toBeNull();
  // /me works
  const me = await app.request("/api/auth/me", { headers: { cookie: `session=${session}` } });
  expect(me.status).toBe(200);
});

it("reuses the existing row on subsequent logins (no duplicate)", async () => {
  currentEmail = `reuse-${crypto.randomUUID()}@noxvytop.com`;
  await createUsersRepo(sql).create({ email: currentEmail, displayName: "Existing" });
  const before = (await createUsersRepo(sql).list()).filter((u) => u.email === currentEmail).length;
  await runLoginFlow();
  const after = (await createUsersRepo(sql).list()).filter((u) => u.email === currentEmail).length;
  expect(after).toBe(before); // still 1, not duplicated
});

it("refuses login for an archived user", async () => {
  currentEmail = `arch-${crypto.randomUUID()}@noxvytop.com`;
  const u = await createUsersRepo(sql).create({ email: currentEmail, displayName: "Arch" });
  await createUsersRepo(sql).setActive(u.id, false);
  const cb = await runCallback(); // returns the raw callback Response
  expect(cb.headers.get("location")).toBe("/?auth_error=account_archived");
  // no session cookie set
  expect(cookieValue(cb, "session")).toBeNull();
});
```

Provide the concrete `runLoginFlow`/`runCallback`/`cookieValue` helpers by copying the cookie-extraction and login/callback request pattern from `login-flow.test.ts` (that file already does `/api/auth/login` → capture `oidc_state` + `state` → `/api/auth/callback?...`). Keep the stub verifier reading a module-level `currentEmail`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bunx vitest run src/modules/auth/jit-provisioning.test.ts`
Expected: FAIL — first test fails because the current callback denies unknown users (`/?auth_error=unknown_user`), so no session is issued.

- [ ] **Step 3: Implement** — apply the reconciliation contract above in `apps/server/src/modules/auth/router.ts`, replacing the `if (!user) { audit login.denied; redirect unknown_user }` block. Keep everything else (token exchange, cookie, `login.success` audit) intact.

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/modules/auth` (whole auth module)
Expected: JIT tests PASS; existing `login-flow.test.ts` — NOTE: its "redirects unknown users with an error" case now changes meaning. Update that specific F1 test: an unknown user is no longer denied, it is JIT-created. Change that test to assert JIT creation + session instead of `unknown_user`, OR remove it if the new `jit-provisioning.test.ts` fully covers it (state that choice in the report). All other login-flow assertions stay.

- [ ] **Step 5: Full server suite + typecheck**

Run: `bunx vitest run && bun run typecheck` (inside apps/server)
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/auth
git commit -m "feat(server): jit-provision users on first sso login, block archived"
```

---

### Task 4: Shared admin contracts + `requireAdmin` middleware

**Files:**
- Create: `packages/shared/src/api/admin.ts`; export from `packages/shared/src/index.ts`
- Create: `apps/server/src/modules/admin/middleware.ts`
- Test: `packages/shared/src/api/admin.test.ts`, `apps/server/src/modules/admin/middleware.test.ts`

**Interfaces (produces):**

`packages/shared/src/api/admin.ts`:

```ts
import { z } from "zod";

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
  active: z.boolean(),
  mailboxLinked: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const createUserInputSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.enum(["employee", "admin"]).default("employee"),
  locale: z.string().min(2).default("es"),
  mailPassword: z.string().min(8).optional(),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

export const setRoleInputSchema = z.object({ role: z.enum(["employee", "admin"]) });
export const setActiveInputSchema = z.object({ active: z.boolean() });
export const setMailCredentialInputSchema = z.object({ mailPassword: z.string().min(8) });
```

`apps/server/src/modules/admin/middleware.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { requireSession, type AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";

export function requireAdmin(
  sessions: SessionStore,
): MiddlewareHandler<{ Variables: AuthVariables }>[] {
  return [
    requireSession(sessions),
    async (c, next) => {
      if (c.get("user").role !== "admin") {
        return c.json(
          { code: "forbidden", message: "errors.forbidden", traceId: c.get("traceId") },
          403,
        );
      }
      await next();
    },
  ];
}
```

(Returns an array of two middlewares — session first, then role check. Hono accepts spreading middleware arrays into `.use`/route handlers.)

- [ ] **Step 1: Write the failing tests.**

`packages/shared/src/api/admin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adminUserSchema, createUserInputSchema } from "./admin";

describe("admin contracts", () => {
  it("parses an admin user with mailboxLinked", () => {
    const u = adminUserSchema.parse({
      id: "1", email: "a@x.com", displayName: "A", role: "admin",
      locale: "es", active: true, mailboxLinked: false,
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
```

`apps/server/src/modules/admin/middleware.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createSessionStore } from "../auth/sessions";
import type { AuthVariables } from "../auth/middleware";
import { requireAdmin } from "./middleware";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);

function appWithGuard() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("traceId", "t");
    await next();
  });
  app.get("/admin/ping", ...requireAdmin(sessions), (c) => c.json({ ok: true }));
  return app;
}

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
});
afterAll(() => sql.end());

describe("requireAdmin", () => {
  it("401 without a session", async () => {
    const res = await appWithGuard().request("/admin/ping");
    expect(res.status).toBe(401);
  });
  it("403 for an employee session", async () => {
    const u = await createUsersRepo(sql).create({
      email: `e-${crypto.randomUUID()}@noxvytop.com`, displayName: "E",
    });
    const { token } = await sessions.create(u.id, 1);
    const res = await appWithGuard().request("/admin/ping", { headers: { cookie: `session=${token}` } });
    expect(res.status).toBe(403);
  });
  it("200 for an admin session", async () => {
    const u = await createUsersRepo(sql).create({
      email: `ad-${crypto.randomUUID()}@noxvytop.com`, displayName: "Ad", role: "admin",
    });
    const { token } = await sessions.create(u.id, 1);
    const res = await appWithGuard().request("/admin/ping", { headers: { cookie: `session=${token}` } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify both fail.**
- [ ] **Step 3: Implement** the shared contracts (+ index export) and the middleware.
- [ ] **Step 4: Run both suites + typecheck green** (`bunx vitest run` in packages/shared and apps/server).
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/admin.ts packages/shared/src/api/admin.test.ts packages/shared/src/index.ts apps/server/src/modules/admin
git commit -m "feat: add admin contracts and requireAdmin middleware"
```

---

### Task 5: Admin users router (list, create, set role/active/credential)

**Files:**
- Create: `apps/server/src/modules/admin/router.ts`
- Modify: `apps/server/src/app.ts` (mount `adminRouter` at `/api/admin`)
- Test: `apps/server/src/modules/admin/admin-users.test.ts`

**Interfaces:**
- Consumes: `UsersRepo` (Task 1), `MailCredentialsRepo` (F1), `AuditRepo` (F1), `SessionStore` (+ `revokeAllForUser` Task 2), `requireAdmin` (Task 4), the shared admin schemas (Task 4).
- Produces: `createAdminRouter(deps: AdminDeps)`; `createApp` gains optional `adminRouter`.

```ts
export type AdminDeps = {
  sessions: SessionStore;
  users: UsersRepo;
  mailCredentials: MailCredentialsRepo;
  audit: AuditRepo;
};
```

**Route contract** (all guarded by `requireAdmin`, all admin actions audited, actor = the admin's email from `c.get("user")`):

- `GET /api/admin/users` → `AdminUser[]`: map `users.list()`; `mailboxLinked` = `mailCredentials.get(id) !== null` (do this per user; N is small in F2). Response array validated against the shared schema shape.
- `POST /api/admin/users` — body `createUserInputSchema`. 400 `invalid_body` (incl. malformed JSON). 409 `user_exists` if `findByEmail` hits. Create the row; if `mailPassword` present, `mailCredentials.set(id, mailPassword)`. Audit `user.create` (detail `{ role }`, never the password). Return the `AdminUser`.
- `PUT /api/admin/users/:id/role` — body `setRoleInputSchema`. `setRole`; 404 `not_found` if null. Audit `user.role_change` (detail `{ role }`). Return `AdminUser`.
- `PUT /api/admin/users/:id/credential` — body `setMailCredentialInputSchema`. Requires the user to exist (`findByEmail`? no — look up by id: add `users.findById`? Simpler: attempt `mailCredentials.set(id, mailPassword)` only after confirming the user exists via a lightweight check). To avoid adding a repo method, guard with: `const target = (await users.list()).find(u => u.id === id)`; 404 if missing. Then `mailCredentials.set(id, mailPassword)`. Audit `user.credential_set` (never the password). Return `{ ok: true }`.
- `PUT /api/admin/users/:id/active` — body `setActiveInputSchema`. `setActive`; 404 if null. When set to `false`, also `sessions.revokeAllForUser(id)`. Audit `user.archive` / `user.reactivate` accordingly (detail `{ revokedSessions }` on archive). Return `AdminUser`.

Malformed JSON: wrap `c.req.json()` in try/catch → 400 `invalid_body`, as F1 does.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/admin/admin-users.test.ts`. Scaffolding like F1 setup/admin tests: real Postgres; build the app with `createApp({ adminRouter: createAdminRouter(deps) })`; seed an admin user + session token for the `cookie` header. Cases:
  1. `GET /users` without admin session → 401; with employee → 403; with admin → 200 and returns the seeded users, each with `mailboxLinked` boolean.
  2. `POST /users` with `{ email, displayName, mailPassword }` → 200 `AdminUser`; response has no password fields; `mailCredentials.get` returns the password; duplicate email → 409; invalid body → 400.
  3. `PUT /users/:id/role {role:"admin"}` → 200 role admin; missing id → 404.
  4. `PUT /users/:id/active {active:false}` on a user WITH an active session → 200 `active:false` AND that session no longer works (`/api/auth/me` with it → 401). Reactivate → 200 `active:true`.
  5. `PUT /users/:id/credential {mailPassword}` → 200; `mailCredentials.get` returns it; missing id → 404.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the router per contract and mount it in `app.ts` (`if (options.adminRouter) app.route("/api/admin", options.adminRouter as never)`).
- [ ] **Step 4: Full server suite + typecheck green.**
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/admin/router.ts apps/server/src/modules/admin/admin-users.test.ts apps/server/src/app.ts
git commit -m "feat(server): add admin users router with archive and session revocation"
```

---

### Task 6: Wire the admin router into the entry point

**Files:**
- Modify: `apps/server/src/index.ts`
- Test: covered by Task 5 (unit) + a live check here.

**Interfaces:**
- Consumes: everything above.
- Produces: `/api/admin/*` live in the running app.

- [ ] **Step 1: Wire it** — in `apps/server/src/index.ts`, build the admin router from the already-constructed repos and pass it to `createApp`:

```ts
import { createAdminRouter } from "./modules/admin/router";
```

```ts
const app = createApp({
  checks: { postgres: () => checkDb(db) },
  authRouter: createAuthRouter({ /* ...existing... */ }),
  setupRouter: createSetupRouter({ /* ...existing... */ }),
  mailRouter: createMailRouter({ /* ...existing... */ }),
  adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit }),
});
```

(`sessions`, `users`, `mailCredentials`, `audit` are already constructed in `index.ts` for the auth/setup wiring — reuse them.)

- [ ] **Step 2: Verify** — `bun run typecheck` (root) and `bun run test` (root, Postgres up) all green.

- [ ] **Step 3: Live check** — recreate the dev container, poll `http://localhost:8090/api/health` until 200, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/api/admin/users
```

Expected: `401` (no session — the guard is live). Capture in the report.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): wire admin router into the app entry"
```

---

## Out of Scope (later F2 plans)

- Plan 2: dual-mode login (bootstrap emergency form on the login screen).
- Plan 3: admin portal UI (`/admin` — users table, OIDC/integrations config migrated from the F1 setup screen).
- Plan 4: mail groups (sidebar Groups zone + unified-inbox view toggle in `user_preferences`).
- Shared mailboxes with credential (Model B) — deferred to issue #13.
