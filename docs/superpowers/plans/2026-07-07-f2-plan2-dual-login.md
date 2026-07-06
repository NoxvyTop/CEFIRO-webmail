# F2 Plan 2/4 — Dual-Mode Login (bootstrap emergency entry)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The login screen offers a second way in — an email+password form that validates the local bootstrap credential and grants a real admin session — but only when bootstrap mode is active. In normal operation the form does not exist; only the SSO button shows.

**Architecture:** Extends the F1 auth module. A public `GET /api/auth/mode` tells the frontend whether bootstrap is active. `POST /api/auth/bootstrap` (404 when bootstrap is off) validates the console credential against the existing `Bootstrap` verifier, ensures a reserved `bootstrap-admin` user row (role admin), and issues a normal session cookie — so the emergency admin uses the same app/portal as any admin. No ROPC: the Authentik password never touches the BFF. See `docs/superpowers/specs/2026-07-06-phase2-admin-portal-design.md` §2.

**Tech Stack:** existing — Bun + Hono + TS, React + Vite, Zod, Vitest. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys, es (neutral Spanish) default / en fallback; conventional commits; no AI attribution; no compiled `.js` committed.
- TDD per task: write the test, run it and SEE IT FAIL (capture output), implement, see it pass; both outputs in the report.
- Runtime-agnostic backend: Web APIs only in `modules/`/`core/`; Bun-only APIs confined to `src/index.ts`.
- Error envelope uniform `{ code, message, traceId }` with `message` an i18n key.
- Secrets never logged; the bootstrap credential is never echoed or stored beyond the existing in-memory hash; audit never carries the password.
- `apps/server/vitest.config.ts` has `fileParallelism: false` — keep it, don't touch it.
- Postgres for integration tests: dev container on host port 5434, `DATABASE_URL` fallback `postgres://webmail:webmail@localhost:5434/webmail`.
- NEVER kill processes globally; prefer running inside the dev container.
- Every task runs `bun run typecheck` and its tests before committing.
- Branch: `init-dual-login`.

---

### Task 1: Shared contracts + `GET /api/auth/mode`

**Files:**
- Modify: `packages/shared/src/api/auth.ts` (add two schemas); it is already exported via `packages/shared/src/index.ts`.
- Modify: `apps/server/src/modules/auth/router.ts` (add `bootstrap` dep + `GET /mode` route)
- Test: `packages/shared/src/api/auth.test.ts` (create if absent), `apps/server/src/modules/auth/auth-mode.test.ts`

**Interfaces (produces):**

Append to `packages/shared/src/api/auth.ts`:

```ts
export const authModeSchema = z.object({ bootstrapMode: z.boolean() });
export type AuthMode = z.infer<typeof authModeSchema>;

export const bootstrapLoginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});
export type BootstrapLoginInput = z.infer<typeof bootstrapLoginSchema>;
```

(`auth.ts` already imports `z` for `sessionUserSchema`; reuse it. If `auth.ts` does not currently import zod, add `import { z } from "zod";` at the top.)

`apps/server/src/modules/auth/router.ts` changes:
- Add `import type { Bootstrap } from "../setup/bootstrap";`
- Add `bootstrap?: Bootstrap;` to `AuthRouterDeps`.
- Add the route (place it near `/me`, unguarded — the login screen calls it before any session exists):

```ts
  router.get("/mode", (c) => c.json({ bootstrapMode: deps.bootstrap?.enabled ?? false }));
```

- [ ] **Step 1: Write the failing tests.**

`packages/shared/src/api/auth.test.ts` (create; if it exists, append the describe):

```ts
import { describe, expect, it } from "vitest";
import { authModeSchema, bootstrapLoginSchema } from "./auth";

describe("auth mode + bootstrap login contracts", () => {
  it("authModeSchema parses a boolean flag", () => {
    expect(authModeSchema.parse({ bootstrapMode: true }).bootstrapMode).toBe(true);
    expect(() => authModeSchema.parse({ bootstrapMode: "yes" })).toThrow();
  });
  it("bootstrapLoginSchema requires non-empty email and password", () => {
    expect(bootstrapLoginSchema.parse({ email: "bootstrap-admin", password: "p" }).email).toBe(
      "bootstrap-admin",
    );
    expect(() => bootstrapLoginSchema.parse({ email: "", password: "p" })).toThrow();
    expect(() => bootstrapLoginSchema.parse({ email: "x", password: "" })).toThrow();
  });
});
```

`apps/server/src/modules/auth/auth-mode.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createSessionStore } from "./sessions";
import { createAuthRouter } from "./router";
import { createBootstrap } from "../setup/bootstrap";
import { createApp } from "../../app";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);
const sessions = createSessionStore(sql);

afterAll(() => sql.end());

function appWith(enabled: boolean) {
  return createApp({
    authRouter: createAuthRouter({ sessions, bootstrap: createBootstrap(enabled) }),
  });
}

describe("GET /api/auth/mode", () => {
  it("reports bootstrapMode true when enabled", async () => {
    const res = await appWith(true).request("/api/auth/mode");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bootstrapMode: boolean }).bootstrapMode).toBe(true);
  });
  it("reports false when disabled and with no bootstrap dep", async () => {
    expect(
      ((await (await appWith(false).request("/api/auth/mode")).json()) as { bootstrapMode: boolean })
        .bootstrapMode,
    ).toBe(false);
    const noDep = createApp({ authRouter: createAuthRouter({ sessions }) });
    expect(
      ((await (await noDep.request("/api/auth/mode")).json()) as { bootstrapMode: boolean })
        .bootstrapMode,
    ).toBe(false);
  });
});
```

(`migrate` import is present for parity with sibling tests even though `/mode` needs no tables; keep the pool open/closed cleanly. If lint flags the unused `migrate`, drop that import.)

- [ ] **Step 2: Run to verify both fail** (`bunx vitest run src/api/auth.test.ts` in packages/shared — cannot resolve the new schemas; `bunx vitest run src/modules/auth/auth-mode.test.ts` in apps/server — 404 on `/mode`).
- [ ] **Step 3: Implement** the two shared schemas and the router `bootstrap` dep + `/mode` route.
- [ ] **Step 4: Both suites + typecheck green.**
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/auth.ts packages/shared/src/api/auth.test.ts packages/shared/src/index.ts apps/server/src/modules/auth/router.ts apps/server/src/modules/auth/auth-mode.test.ts
git commit -m "feat: add auth mode endpoint and bootstrap login contracts"
```

---

### Task 2: `POST /api/auth/bootstrap` — emergency admin session

**Files:**
- Modify: `apps/server/src/modules/auth/router.ts` (add the route + the reserved-admin constant)
- Test: `apps/server/src/modules/auth/bootstrap-login.test.ts`

**Interfaces:**
- Consumes: `Bootstrap` (`.enabled`, `.verify(password)`), `UsersRepo` (`findByEmail`/`create`/`setActive`/`setRole`), `AuditRepo`, `SessionStore` (`create`), `SESSION_COOKIE`, `deps.appUrl`, `deps.sessionTtlHours`, the shared `bootstrapLoginSchema`.
- Produces: `POST /api/auth/bootstrap`. Reserved account: `const BOOTSTRAP_ADMIN_EMAIL = "bootstrap-admin@webmail.local";`

**Route contract:**
- Bootstrap disabled OR missing `users`/`audit` deps → 404 `{ code: "not_found" }` (invisible surface, like `/api/setup`).
- Body parsed with `bootstrapLoginSchema`; malformed JSON or invalid body → 400 `invalid_body` (wrap `c.req.json()` in try/catch).
- `bootstrap.verify(password)` false → audit `bootstrap.login_failed` (actor `BOOTSTRAP_ADMIN_EMAIL`, ip from `x-forwarded-for`, NO password in detail) → 401 `unauthorized`. The submitted `email` is not validated against anything (the console credential is a password; email is cosmetic).
- Success → ensure the reserved admin row:
  - `findByEmail(BOOTSTRAP_ADMIN_EMAIL)`; if null → `create({ email, displayName: "Bootstrap Admin", role: "admin" })`.
  - if it exists but `!active` → `setActive(id, true)`; if `role !== "admin"` → `setRole(id, "admin")`.
- Create a session (`sessionTtlHours ?? 12`), set the `session` cookie exactly like the OIDC callback (`httpOnly`, `path "/"`, `sameSite "Lax"`, `secure: (appUrl ?? "").startsWith("https")`, `maxAge: ttl*3600`). Audit `bootstrap.login`. Return `{ ok: true }`.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/auth/bootstrap-login.test.ts`. Real Postgres for users/sessions; build `createApp({ authRouter: createAuthRouter({ sessions, users, audit, bootstrap, appUrl: "http://localhost:5173", sessionTtlHours: 1 }) })`. Use a `createBootstrap(true)` and read its `.password` for the valid credential. Cookie-extraction helper as in `login-flow.test.ts` (`getSetCookie`). Cases:

```ts
// enabled + correct password → 200, session cookie set, /me works and role is admin
it("logs in the bootstrap admin and issues an admin session", async () => {
  const boot = createBootstrap(true);
  const app = makeApp(boot); // helper building createApp with boot + real repos
  const res = await app.request("/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "bootstrap-admin", password: boot.password }),
  });
  expect(res.status).toBe(200);
  const session = cookieValue(res, "session");
  expect(session).toBeTruthy();
  const me = await app.request("/api/auth/me", { headers: { cookie: `session=${session}` } });
  expect(me.status).toBe(200);
  expect(((await me.json()) as { role: string }).role).toBe("admin");
});

// wrong password → 401, no cookie
it("rejects a wrong credential", async () => {
  const boot = createBootstrap(true);
  const res = await makeApp(boot).request("/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x", password: "wrong" }),
  });
  expect(res.status).toBe(401);
  expect(cookieValue(res, "session")).toBeNull();
});

// bootstrap disabled → 404 (invisible)
it("is 404 when bootstrap is disabled", async () => {
  const res = await makeApp(createBootstrap(false)).request("/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x", password: "y" }),
  });
  expect(res.status).toBe(404);
});

// malformed body → 400
it("400 on invalid body", async () => {
  const boot = createBootstrap(true);
  const res = await makeApp(boot).request("/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(res.status).toBe(400);
});

// second login reuses the same reserved admin row (no duplicate)
it("reuses the reserved admin row on repeat login", async () => {
  const boot = createBootstrap(true);
  const app = makeApp(boot);
  await app.request("/api/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x", password: boot.password }) });
  await app.request("/api/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x", password: boot.password }) });
  const rows = (await createUsersRepo(sql).list()).filter((u) => u.email === "bootstrap-admin@webmail.local");
  expect(rows.length).toBe(1);
});
```

Provide `makeApp(boot)` and `cookieValue` inline (model on `login-flow.test.ts`). `makeApp` builds `createApp` with the real `sessions`, `createUsersRepo(sql)`, `createAuditRepo(sql)`, the given `boot`, `appUrl`, `sessionTtlHours: 1`.

- [ ] **Step 2: Run to verify it fails** (404 on the new route).
- [ ] **Step 3: Implement** the route + constant per contract.
- [ ] **Step 4: Full server suite + typecheck green.**
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/auth/router.ts apps/server/src/modules/auth/bootstrap-login.test.ts
git commit -m "feat(server): add bootstrap emergency login endpoint"
```

---

### Task 3: Login screen — dual-mode form

**Files:**
- Modify: `apps/web/src/features/auth/LoginPage.tsx`, `apps/web/src/features/auth/useAuth.ts` (add a `bootstrapLogin` helper), locales `es.json`/`en.json`
- Test: `apps/web/src/features/auth/login-bootstrap.test.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/mode` (`authModeSchema`), `POST /api/auth/bootstrap`.
- Produces: LoginPage renders the emergency form only when `bootstrapMode` is true.

**Contract:**
- `useAuth.ts` gains an exported helper (module-level function, not part of the hook is fine):

```ts
export async function bootstrapLogin(email: string, password: string): Promise<boolean> {
  const res = await fetch("/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res.ok;
}
```

- `LoginPage`:
  - `useQuery(["auth","mode"], fetchMode)` where `fetchMode` GETs `/api/auth/mode` and parses with `authModeSchema` (import from `@webmail/shared`).
  - Always renders the app title, the existing `auth_error` banner, and the SSO anchor (unchanged).
  - When `mode?.bootstrapMode === true`, ALSO render a `<form>` (section labelled `t("auth.bootstrap.title")`) with a `<label htmlFor>`+`id` email input (`t("auth.bootstrap.email")`), a password input (`t("auth.bootstrap.password")`, `type="password"`), a submit button (`t("auth.bootstrap.submit")`), and a hint line (`t("auth.bootstrap.hint")`). On submit (preventDefault): `const ok = await bootstrapLogin(email, password)`; if ok → `queryClient.invalidateQueries({ queryKey: ["auth","me"] })` then `navigate("/")`; else set an error state showing `t("auth.bootstrap.error")`.
  - When `bootstrapMode` is false/undefined, the form is NOT in the DOM.
- i18n keys (es / en) added under `auth.bootstrap`:
  - `title`: "Acceso de emergencia" / "Emergency access"
  - `email`: "Usuario" / "User"
  - `password`: "Contraseña" / "Password"
  - `submit`: "Entrar" / "Sign in"
  - `error`: "Credencial inválida" / "Invalid credential"
  - `hint`: "Solo disponible en modo de configuración o recuperación" / "Only available in setup or recovery mode"

- [ ] **Step 1: Write the failing test** — `apps/web/src/features/auth/login-bootstrap.test.tsx`. Render the routes (model on `auth.test.tsx`) with a QueryClientProvider + memory router at `/`. Stub `fetch` per URL. Cases:
  1. mode `{bootstrapMode:true}` + `/me` 401 → the emergency form is shown: `screen.getByLabelText("Usuario")`, `getByLabelText("Contraseña")`, button "Entrar" present.
  2. mode `{bootstrapMode:false}` + `/me` 401 → the SSO button "Iniciar sesión con SSO" is present but `queryByLabelText("Contraseña")` is null (form absent).
  3. Fill user+password, click "Entrar" with `/api/auth/bootstrap` stubbed `{ok:true}` (200) → assert a POST went to `/api/auth/bootstrap` with the typed values in the body. (Then `/me` re-fetch can stay 401 in the stub; asserting the POST fired is enough for this unit.)

Use `waitFor`/`findBy` for the async mode query. Reset fetch between cases.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full apps/web suite + typecheck green.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/auth apps/web/src/app/locales
git commit -m "feat(web): add bootstrap emergency form to the login screen"
```

---

### Task 4: Wire bootstrap into the auth router + verification

**Files:**
- Modify: `apps/server/src/index.ts` (pass `bootstrap` into `createAuthRouter`)

**Interfaces:**
- Consumes: everything above. `bootstrap` is already constructed in `index.ts` (`const bootstrap = createBootstrap(config.bootstrapMode)`).

- [ ] **Step 1: Wire it** — in `apps/server/src/index.ts`, add `bootstrap` to the `createAuthRouter({ ... })` deps object (it already receives `sessions, users, audit, ssoConfig, masterKey, appUrl, sessionTtlHours`). Add `bootstrap,`.

- [ ] **Step 2: Verify** — `bun run typecheck` (root) and `bun run test` (root, Postgres up) all green.

- [ ] **Step 3: Live check** — recreate the dev container (it boots with `BOOTSTRAP_MODE=true` per `docker-compose.dev.yml`), poll `http://localhost:8090/api/health` until 200, then:

```bash
# mode reflects bootstrap on
curl -s http://localhost:8090/api/auth/mode                       # {"bootstrapMode":true}
# grab the console bootstrap password
docker compose -f docker-compose.dev.yml logs dev | grep "bootstrap mode active"
# bootstrap login with the printed PASSWORD returns a session cookie
curl -s -i -X POST http://localhost:8090/api/auth/bootstrap \
  -H "content-type: application/json" \
  -d '{"email":"bootstrap-admin","password":"<PASSWORD>"}' | grep -i "set-cookie: session"
# wrong password → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8090/api/auth/bootstrap \
  -H "content-type: application/json" -d '{"email":"x","password":"wrong"}'   # 401
```

Capture the outputs in the report.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): wire bootstrap into the auth router for emergency login"
```

---

## Out of Scope (later F2 plans)

- Plan 3: admin portal UI (`/admin` — users table, OIDC/integrations config migrated from the F1 setup screen).
- Plan 4: mail groups (sidebar Groups zone + unified-inbox view toggle in `user_preferences`).
- Shared mailboxes with credential (Model B) — deferred to issue #13.
