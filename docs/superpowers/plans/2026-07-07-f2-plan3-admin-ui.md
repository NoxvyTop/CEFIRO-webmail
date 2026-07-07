# F2 Plan 3/4 — Admin Portal UI (`/admin`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins get a `/admin` portal: a users table (JIT-created + admin-created) showing mailbox-linked status, with actions to link/edit each user's Stalwart credential, change role, archive/reactivate, and proactively create users — plus an OIDC provider config panel. Non-admins never see it.

**Architecture:** New `features/admin` frontend feature consuming the Plan 1 `/api/admin/users` API (validated with `@webmail/shared` admin contracts). A `RequireAdmin` guard wraps the `/admin` route (session + role admin). A small admin-session-gated OIDC config API (`GET/PUT /api/admin/sso`) reuses the F1 `ssoConfig` repo — the GET never returns the client secret. See `docs/superpowers/specs/2026-07-06-phase2-admin-portal-design.md` §3.

**Tech Stack:** existing — React + Vite, TanStack Query, i18next, Bun + Hono, Zod, Vitest. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys, es (neutral Spanish) default / en fallback; conventional commits; no AI attribution; no compiled `.js` committed.
- TDD per task: write the test, run it and SEE IT FAIL (capture output), implement, see it pass; both outputs in the report.
- Runtime-agnostic backend; error envelope uniform `{ code, message, traceId }` with `message` an i18n key.
- Secrets never sent to the browser, never logged; admin actions audited; the OIDC client secret is write-only from the UI (GET returns issuer/clientId/scopes + a configured flag, never the secret).
- `apps/server/vitest.config.ts` has `fileParallelism: false` — keep it.
- Postgres for integration tests: dev container on host port 5434, `DATABASE_URL` fallback `postgres://webmail:webmail@localhost:5434/webmail`.
- NEVER kill processes globally; prefer running inside the dev container.
- Every task runs `bun run typecheck` and its tests before committing.
- Branch: `init-admin-ui`.

---

### Task 1: Admin OIDC config API (`GET/PUT /api/admin/sso`)

**Files:**
- Modify: `packages/shared/src/api/admin.ts` (add the view schema); it is exported via `packages/shared/src/index.ts`.
- Modify: `apps/server/src/infra/repos/sso-config.ts` (add non-decrypting `getPublic()`)
- Modify: `apps/server/src/modules/admin/router.ts` (add the two routes + `ssoConfig` dep)
- Modify: `apps/server/src/index.ts` (pass `ssoConfig` into `createAdminRouter`)
- Test: `apps/server/src/modules/admin/admin-sso.test.ts`

**Interfaces (produces):**

Append to `packages/shared/src/api/admin.ts` (it already imports `z`):

```ts
export const adminSsoViewSchema = z.object({
  configured: z.boolean(),
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  scopes: z.string().nullable(),
});
export type AdminSsoView = z.infer<typeof adminSsoViewSchema>;
```

Reuse the existing `setupSsoSchema` (from `@webmail/shared`, `{ issuer, clientId, clientSecret, scopes }`) for the PUT body.

`apps/server/src/infra/repos/sso-config.ts` — add a non-decrypting reader alongside `get`/`set`/`exists`:

```ts
    async getPublic(): Promise<{ issuer: string; clientId: string; scopes: string } | null> {
      const rows = await sql<{ issuer: string; client_id: string; scopes: string }[]>`
        select issuer, client_id, scopes from sso_config where id = 1
      `;
      const row = rows[0];
      return row ? { issuer: row.issuer, clientId: row.client_id, scopes: row.scopes } : null;
    },
```

`apps/server/src/modules/admin/router.ts` — add `ssoConfig: SsoConfigRepo` to `AdminDeps`, and two routes (guarded by the existing `requireAdmin` applied to `"*"`; audited with actor = `c.get("user").email`):

- `GET /api/admin/sso` → `const pub = await deps.ssoConfig.getPublic();` → respond `AdminSsoView`: `pub ? { configured: true, ...pub } : { configured: false, issuer: null, clientId: null, scopes: null }`. Never touches the secret.
- `PUT /api/admin/sso` → body `setupSsoSchema` (400 `invalid_body` incl. malformed JSON). `await deps.ssoConfig.set(parsed.data)`. Audit `sso_config.update` (detail `{ issuer, clientId }`, NEVER the secret). Return `{ ok: true }`.

`apps/server/src/index.ts` — the admin router construction currently is `createAdminRouter({ sessions, users, mailCredentials, audit })`; add `ssoConfig,` (already constructed in `index.ts`).

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/admin/admin-sso.test.ts`. Model on `admin-users.test.ts` (real Postgres, seed an admin user + session token). Build `createApp({ adminRouter: createAdminRouter({ sessions, users, mailCredentials, audit, ssoConfig }) })` with `ssoConfig = createSsoConfigRepo(sql, masterKey)` (a fresh random master key). Cases:
  1. `GET /api/admin/sso` without admin session → 401; as employee → 403.
  2. As admin, before any config → `{ configured: false, issuer: null, ... }`.
  3. `PUT /api/admin/sso` (admin) with `{ issuer: "https://auth.test", clientId: "webmail", clientSecret: "s", scopes: "openid email" }` → 200 `{ ok: true }`. Then `GET` → `{ configured: true, issuer: "https://auth.test", clientId: "webmail", scopes: "openid email" }` and the response body does NOT contain the string `"s"` as clientSecret (assert `JSON.stringify(body)` has no `clientSecret` key).
  4. `PUT` invalid body → 400.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the schema, `getPublic()`, the two routes, and the `index.ts` wiring.
- [ ] **Step 4: Full server + shared suites + typecheck green.**
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/admin.ts apps/server/src/infra/repos/sso-config.ts apps/server/src/modules/admin/router.ts apps/server/src/modules/admin/admin-sso.test.ts apps/server/src/index.ts
git commit -m "feat(server): add admin-gated oidc config endpoints"
```

---

### Task 2: Admin frontend API client

**Files:**
- Create: `apps/web/src/features/admin/api.ts`
- Test: `apps/web/src/features/admin/api.test.ts`

**Interfaces (produces):**

```ts
import {
  adminSsoViewSchema, adminUserSchema,
  type AdminSsoView, type AdminUser, type CreateUserInput,
} from "@webmail/shared";
import { z } from "zod";
import { MailApiError } from "../mailbox/api";

// parseError pattern reused from mailbox/api.ts (throw MailApiError with the envelope code)
export async function fetchAdminUsers(): Promise<AdminUser[]>;                    // GET /api/admin/users
export async function createAdminUser(input: CreateUserInput): Promise<AdminUser>; // POST /api/admin/users
export async function setUserRole(id: string, role: "employee" | "admin"): Promise<AdminUser>; // PUT /users/:id/role
export async function setUserActive(id: string, active: boolean): Promise<AdminUser>;           // PUT /users/:id/active
export async function setUserCredential(id: string, mailPassword: string): Promise<void>;       // PUT /users/:id/credential
export async function fetchAdminSso(): Promise<AdminSsoView>;                     // GET /api/admin/sso
export async function updateAdminSso(input: {
  issuer: string; clientId: string; clientSecret: string; scopes: string;
}): Promise<void>;                                                               // PUT /api/admin/sso
```

All: `fetch` → on non-ok `parseError(res)` throwing `MailApiError(status, code)` → else validate with the shared schema (`z.array(adminUserSchema)`, `adminUserSchema`, `adminSsoViewSchema`) or resolve void. Bodies are JSON.

- [ ] **Step 1: Write the failing test** — `apps/web/src/features/admin/api.test.ts`. Stub `fetch` per URL. Assert: fetchAdminUsers parses an array; createAdminUser POSTs the input body; setUserRole PUTs `{role}` to `/api/admin/users/<id>/role`; setUserActive PUTs `{active}`; setUserCredential PUTs `{mailPassword}`; fetchAdminSso parses the view; updateAdminSso PUTs to `/api/admin/sso`; a 403 response throws `MailApiError` with `code: "forbidden"`.
- [ ] **Step 2: Run to verify it fails.** **Step 3: Implement.** **Step 4: apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add admin api client`

---

### Task 3: RequireAdmin guard + `/admin` route + header link

**Files:**
- Create: `apps/web/src/features/admin/RequireAdmin.tsx`
- Modify: `apps/web/src/app/routes.tsx` (add `/admin`), `apps/web/src/app/App.tsx` (admin link in header, only for admins), locales
- Test: `apps/web/src/features/admin/require-admin.test.tsx`

**Contract:**
- `RequireAdmin` props `{ children }`: uses `useAuth()`. While `isLoading` → render null. If `!user` → render the existing `LoginPage` (import from `../auth/LoginPage`). If `user.role !== "admin"` → render a `t("admin.forbidden")` message (`role="alert"`), plus a link back to `/`. If admin → render children.
- `routes.tsx`: add `{ path: "/admin", element: <RequireAdmin><AdminPage/></RequireAdmin> }` (AdminPage is built in Task 4; for THIS task, use a placeholder `<main aria-label={t("admin.title")}>` component or import the real AdminPage if Task 4 lands first — to keep this task independently testable, create a minimal `AdminPage` stub in `features/admin/AdminPage.tsx` that renders `<main>{t("admin.title")}</main>`; Task 4 fills it in).
- `App.tsx` header: when `user?.role === "admin"`, render a link to `/admin` (`t("admin.title")`). Non-admins don't see it. Keep the existing Settings link and other header content.
- i18n keys (es / en): `admin.title` "Administración" / "Administration", `admin.forbidden` "No tenés permisos de administrador" / "You do not have admin permissions", `admin.back` "Volver" / "Back".

- [ ] **Step 1: Write the failing test** — `require-admin.test.tsx`: render routes at `/admin` (memory router + QueryClientProvider) with fetch stubbed. Cases: `/me` returns an admin user → the AdminPage stub (`t("admin.title")`) renders; `/me` returns an employee → the forbidden alert renders and the admin content does not; `/me` 401 → the login screen renders (`"Iniciar sesión con SSO"`).
- [ ] **Step 2: Run to verify it fails.** **Step 3: Implement.** **Step 4: apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add require-admin guard, /admin route and header link`

---

### Task 4: AdminPage — users table + actions

**Files:**
- Modify: `apps/web/src/features/admin/AdminPage.tsx` (fill in the stub), locales
- Create: `apps/web/src/features/admin/UserRow.tsx` (one table row + its action controls) if AdminPage grows large; otherwise inline
- Test: `apps/web/src/features/admin/admin-users-ui.test.tsx`

**Contract:**
- `AdminPage` (`<main aria-label={t("admin.title")}>`, heading): a Users section listing `fetchAdminUsers()` via `useQuery(["admin","users"])`. Table columns: email, display name, role, mailbox status (`t("admin.mailbox.linked")` / `t("admin.mailbox.unlinked")` from `mailboxLinked`), active status (`t("admin.status.active")` / `t("admin.status.archived")` from `active`).
- Per-row actions (mutations invalidate `["admin","users"]` on success):
  - **Link/edit credential**: a control opening an inline input for `mailPassword` (type password, min 8) → `setUserCredential(id, pw)`. Label `t("admin.actions.linkMailbox")`.
  - **Change role**: a `<select>` employee/admin → `setUserRole(id, role)`. Label `t("admin.actions.role")`.
  - **Archive / reactivate**: a button toggling `setUserActive(id, !active)`. Labels `t("admin.actions.archive")` / `t("admin.actions.reactivate")`. Archiving is a destructive-ish action — confirm inline (a two-click confirm, NOT a browser `confirm()` dialog which is blocked in this environment): first click shows `t("admin.actions.confirmArchive")`, second click within the same control performs it.
  - **New user** (top of the section): a form (email, display name, role select, optional mailPassword) → `createAdminUser(input)`. Labels under `t("admin.new.*")`.
- Error/empty states: query error → banner `t("admin.errors.load")`; empty list → `t("admin.empty")`. Mutation error → inline `t("admin.errors.action")`.
- i18n keys (es / en) added under `admin.*`:
  - `mailbox.linked` "Buzón vinculado" / "Mailbox linked", `mailbox.unlinked` "Sin vincular" / "Not linked"
  - `status.active` "Activo" / "Active", `status.archived` "Archivado" / "Archived"
  - `columns.email` "Correo" / "Email", `columns.name` "Nombre" / "Name", `columns.role` "Rol" / "Role", `columns.mailbox` "Buzón" / "Mailbox", `columns.status` "Estado" / "Status", `columns.actions` "Acciones" / "Actions"
  - `roles.employee` "Empleado" / "Employee", `roles.admin` "Administrador" / "Admin"
  - `actions.linkMailbox` "Vincular buzón" / "Link mailbox", `actions.saveCredential` "Guardar" / "Save", `actions.role` "Rol" / "Role", `actions.archive` "Archivar" / "Archive", `actions.reactivate` "Reactivar" / "Reactivate", `actions.confirmArchive` "Confirmar archivado" / "Confirm archive"
  - `new.title` "Nuevo usuario" / "New user", `new.email` "Correo" / "Email", `new.name` "Nombre" / "Name", `new.role` "Rol" / "Role", `new.mailPassword` "Contraseña del buzón (opcional)" / "Mailbox password (optional)", `new.create` "Crear" / "Create"
  - `empty` "No hay usuarios" / "No users", `errors.load` "No se pudieron cargar los usuarios" / "Could not load users", `errors.action` "No se pudo completar la acción" / "The action could not be completed"

- [ ] **Step 1: Write the failing test** — `admin-users-ui.test.tsx`: render AdminPage inside providers with `/api/admin/users` stubbed to return two users (one admin+linked+active, one employee+unlinked+active). Assert: both emails render; mailbox status text reflects linked/unlinked; a role select is present; clicking "Vincular buzón" reveals a password input and saving PUTs to `/api/admin/users/<id>/credential` with `{mailPassword}`; the "New user" form POSTs to `/api/admin/users`; archive is two-click (first click shows confirm label, second click PUTs `active:false`).
- [ ] **Step 2: Run to verify it fails.** **Step 3: Implement.** **Step 4: apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add admin users table with credential, role and archive actions`

---

### Task 5: AdminPage — OIDC config panel

**Files:**
- Modify: `apps/web/src/features/admin/AdminPage.tsx` (add a Config section), locales
- Test: `apps/web/src/features/admin/admin-sso-ui.test.tsx`

**Contract:**
- A "Configuración" section in AdminPage below Users. Loads `fetchAdminSso()` via `useQuery(["admin","sso"])`. Shows the current `configured` status + issuer/clientId/scopes (read-only display when configured). A form (issuer, clientId, clientSecret, scopes) submits `updateAdminSso(input)` (client secret is write-only — the field is always empty on load, never pre-filled). Success invalidates `["admin","sso"]` and shows `t("admin.sso.saved")`.
- The client secret input is `type="password"` and its value is NEVER populated from the GET (the GET has no secret).
- i18n keys (es / en): `admin.sso.title` "Proveedor SSO (OIDC)" / "SSO provider (OIDC)", `admin.sso.configured` "Configurado" / "Configured", `admin.sso.notConfigured` "Sin configurar" / "Not configured", `admin.sso.save` "Guardar" / "Save", `admin.sso.saved` "Guardado" / "Saved", `admin.sso.error` "No se pudo guardar" / "Could not save". Field labels `Issuer`, `Client ID`, `Client Secret`, `Scopes` stay in English in both catalogs (protocol terms), consistent with the F1 setup screen.

- [ ] **Step 1: Write the failing test** — `admin-sso-ui.test.tsx`: stub `/api/admin/sso` GET → `{ configured: true, issuer: "https://auth.test", clientId: "webmail", scopes: "openid email" }`. Assert: the configured status + issuer render; the Client Secret input is empty (not populated); filling the form and saving PUTs to `/api/admin/sso` with the entered values incl. clientSecret; on ok, "Guardado" appears.
- [ ] **Step 2: Run to verify it fails.** **Step 3: Implement.** **Step 4: apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add oidc config panel to the admin portal`

---

### Task 6: Verification sweep

**Files:** none new — verification only.

- [ ] **Step 1:** `bun run typecheck` (root) and `bun run test` (root; Postgres 5434 up) — all green.
- [ ] **Step 2:** Dev container: recreate `dev`, poll `http://localhost:8090/api/health` until 200, then:

```bash
# admin API guarded
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/api/admin/users   # 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/api/admin/sso     # 401
# SPA builds with the new admin feature and serves
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173                    # 200
docker compose -f docker-compose.dev.yml exec -T dev sh -c "cd apps/web && bunx vite build" 2>&1 | tail -3   # build succeeds
```

Capture the outputs in the report.

- [ ] **Step 3:** Commit only if anything needed fixing; otherwise report clean.

---

## Out of Scope

- Plan 4: mail groups (sidebar Groups zone + unified-inbox view toggle in `user_preferences`).
- Integrations configurator UI (Odoo) — the `integrations` table stays prepared/empty until F4.
- Shared mailboxes with credential (Model B) — deferred to issue #13.
