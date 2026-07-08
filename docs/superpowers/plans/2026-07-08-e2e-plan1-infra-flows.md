# E2E Plan 1/2 — Playwright infra + mail-independent flows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Playwright E2E suite covering every Céfiro flow that does NOT need the mail server (login screen, shell/header, theme persistence, profile menu, navigation, catch-all redirect, shortcuts overlay, responsive), running against the production-served build, plus a CI job. See `docs/superpowers/specs/2026-07-08-e2e-playwright-design.md`.

**Architecture:** New top-level `e2e/` workspace with `@playwright/test`. `playwright.config.ts`'s `webServer` builds the web (`vite build`) and starts the Hono server serving `apps/web/dist` (NODE_ENV=production) on a test port; `globalSetup` runs migrations + seeds an admin user & session, writing a `storageState` cookie so most specs start authenticated. No production code changes.

**Tech Stack:** existing + `@playwright/test` (dev-only). No server/web source changes.

## Global Constraints

- English code/identifiers/comments/commits; UI copy is asserted via the SAME i18n strings the app renders (es default); conventional commits; no AI attribution.
- **Zero production source changes** — E2E is a self-contained harness. If a spec cannot be written without a source change, STOP and escalate (do not modify app/server code to make a test pass).
- The e2e package script is `test:e2e` (NOT `test`), so the existing `bun run --filter '*' test` unit job ignores it. It gets a `typecheck` script (tsc on specs) so the root typecheck covers it.
- Playwright manages the server lifecycle via `webServer` — **NEVER kill processes globally** (no taskkill/pkill); rely on Playwright's teardown.
- Selectors: prefer role + accessible name (the app is a11y-first) and visible i18n text; never brittle CSS/nth-child.
- DATABASE_URL from env (dev fallback `postgres://webmail:webmail@localhost:5434/webmail`, CI `:5432`).
- Commit e2e artifacts to `.gitignore` (`e2e/.auth`, `e2e/test-results`, `e2e/playwright-report`, `e2e/node_modules`).
- Branch: `init-e2e-playwright`.

## Notes for implementers (verified facts)

- Server auto-runs migrations on boot (`apps/server/src/index.ts:36`) and serves `apps/web/dist` ONLY when `NODE_ENV==="production"` with `STATIC_DIR` (`:78-81`). globalSetup ALSO runs migrations (idempotent) so seeding never races server boot.
- Session cookie name is `session`; `createSessionStore(sql).create(userId, ttlHours)` returns `{ token }` (the DB stores `sha256(token)`). A cookie `session=<token>` authenticates.
- Config needs MASTER_KEY (base64 32B — dev key `ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE=`), APP_URL, DATABASE_URL, PORT, BOOTSTRAP_MODE.
- Workspace names: `@webmail/web`, `@webmail/server`, `@webmail/shared`.

---

### Task 1: e2e workspace, config, seeded-session globalSetup, smoke spec

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/playwright.config.ts`, `e2e/global-setup.ts`, `e2e/tests/smoke.spec.ts`
- Modify: root `.gitignore`, root `package.json` (add `e2e` is already covered by `apps/*`/`packages/*`? NO — e2e is top-level; add it to `workspaces`)

- [ ] **Step 1: Add the dependency + workspace** — `cd e2e` won't exist yet; first create `e2e/package.json`:

```json
{
  "name": "@webmail/e2e",
  "private": true,
  "type": "module",
  "scripts": {
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@webmail/server": "workspace:*",
    "@webmail/shared": "workspace:*",
    "postgres": "^3.4.4",
    "typescript": "^5.6.0"
  }
}
```

Add `"e2e"` to the root `package.json` `workspaces` array (so it becomes `["apps/*", "packages/*", "e2e"]`). Then `bun install` from the repo root. Then `cd e2e && bunx playwright install chromium` (binary is already cached on this machine; CI installs with `--with-deps`).

- [ ] **Step 2: tsconfig** — `e2e/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 3: playwright.config.ts** — `e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 8080);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    storageState: resolve(here, ".auth/state.json"),
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bun run ${resolve(here, "../apps/web")}/node_modules/.bin/vite build --outDir ${resolve(here, "../apps/web/dist")} 1>/dev/null && NODE_ENV=production bun ${resolve(here, "../apps/server/src/index.ts")}`,
        cwd: resolve(here, ".."),
        url: `${BASE_URL}/api/health`,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
        env: {
          NODE_ENV: "production",
          STATIC_DIR: resolve(here, "../apps/web/dist"),
          DATABASE_URL,
          MASTER_KEY: "ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE=",
          APP_URL: BASE_URL,
          PORT: String(PORT),
          BOOTSTRAP_MODE: "true",
        },
      },
});
```

IMPORTANT for the implementer: the `command` above chains a vite build then the server. If the `&&` / redirect syntax is not portable in Playwright's shell on this Windows host, replace it with a dedicated script: add `"e2e:serve"` to the ROOT package.json (`"e2e:serve": "vite build --config apps/web/vite.config.ts && NODE_ENV=production bun apps/server/src/index.ts"`) — but env vars in npm scripts aren't cross-platform either, so prefer keeping env in `webServer.env` and making the command ONLY `bun apps/server/src/index.ts`, running the `vite build` as a SEPARATE `webServer`-independent step: a `globalSetup`-time build, OR a `test:e2e` prescript. Choose the approach that runs green on THIS machine and document it. The acceptance test is: `bunx playwright test tests/smoke.spec.ts` builds, serves, and the smoke spec passes. Verify the served dist actually loads (GET `/` returns the SPA, not a 404).

- [ ] **Step 4: global-setup.ts** — seeds a user + session, writes storageState. `e2e/global-setup.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDb } from "@webmail/server/src/infra/db/client";
import { migrate } from "@webmail/server/src/infra/db/migrate";
import { createUsersRepo } from "@webmail/server/src/infra/repos/users";
import { createSessionStore } from "@webmail/server/src/modules/auth/sessions";

const here = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const url =
    process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
  const sql = createDb(url);
  try {
    await migrate(sql, resolve(here, "../apps/server/migrations"));
    const users = createUsersRepo(sql);
    const email = `e2e-${crypto.randomUUID()}@noxvytop.com`;
    const user = await users.create({ email, displayName: "E2E Admin" });
    await sql`update users set role = 'admin' where id = ${user.id}`;
    const { token } = await createSessionStore(sql).create(user.id, 24);

    const state = {
      cookies: [
        {
          name: "session",
          value: token,
          domain: "localhost",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 86_400,
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    await mkdir(resolve(here, ".auth"), { recursive: true });
    await writeFile(resolve(here, ".auth/state.json"), JSON.stringify(state, null, 2));
  } finally {
    await sql.end();
  }
}
```

If the `@webmail/server/src/...` subpath imports don't resolve (the server package has no `exports` map for src), fall back to a RELATIVE import (`../apps/server/src/infra/db/client`) — verify which resolves under Bun and document. If neither is clean, replicate the two tiny primitives inline (postgres.js insert into `users`, then `insert into sessions (id, user_id, expires_at)` with `id = sha256hex(token)` and a base64url random token) — but PREFER importing the real `createSessionStore` so the token format stays authoritative.

- [ ] **Step 5: smoke spec** — `e2e/tests/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("authenticated shell renders with the Cefiro brand and profile menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("CÉFIRO")).toBeVisible();
  await expect(page.getByRole("button", { name: /Redactar/ })).toBeVisible();
});

test("unauthenticated context lands on the login screen", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CÉFIRO" })).toBeVisible();
  await expect(page.getByText("Acceso de emergencia")).toBeVisible();
  await context.close();
});
```

- [ ] **Step 6: .gitignore** — append:

```
e2e/.auth/
e2e/test-results/
e2e/playwright-report/
e2e/node_modules/
```

- [ ] **Step 7: Run + verify** — `cd e2e && bunx playwright test tests/smoke.spec.ts` — both tests pass (build+serve happens once). Then `bun install` at root succeeds and `bun run --filter '*' test` (the unit job) does NOT pick up e2e (no `test` script). Then root `bun run typecheck` includes e2e's typecheck and is clean.

- [ ] **Step 8: Commit** — `test(e2e): playwright workspace, seeded-session harness and smoke`

---

### Task 2: Mail-independent flow specs

**Files:**
- Create: `e2e/tests/auth.spec.ts`, `e2e/tests/shell.spec.ts`, `e2e/tests/navigation.spec.ts`, `e2e/tests/shortcuts.spec.ts`, `e2e/tests/responsive.spec.ts`

Each spec uses the seeded auth (default) except auth.spec's unauthenticated cases. Use role/name/text selectors matching the rendered es strings. Behaviors to assert (write real Playwright tests — the descriptions below are the acceptance criteria, not code to paste):

- [ ] **auth.spec.ts** (unauthenticated context, cleared storageState):
  - Login screen shows ONLY the emergency form (`Acceso de emergencia`, `Usuario`, `Contraseña`, `Entrar`) and NOT `Iniciar sesión con SSO` when the server is in bootstrap mode.
  - Submitting a wrong password shows the invalid-credential error (`Credencial inválida`) and does NOT navigate (no need for the real bootstrap password — assert the error path).

- [ ] **shell.spec.ts** (authenticated):
  - Header shows the CÉFIRO wordmark, the search box (`Buscar en el correo`), and the avatar button (accessible name matches `Sesión iniciada como …`).
  - Clicking the avatar opens the profile menu: `Ajustes`, `Administración` (admin user), a theme item, `Cerrar sesión`. Escape closes it.
  - Theme toggle: open menu → click the theme item → `document.documentElement` `data-theme` flips and `localStorage["cefiro-theme"]` is set; reload → the chosen theme persists.

- [ ] **navigation.spec.ts** (authenticated):
  - From the profile menu, `Ajustes` navigates to `/settings` and the Firmas/Filtros/Respuestas automáticas sections render INSIDE the shell (the CÉFIRO header still visible).
  - `Administración` navigates to `/admin` and the users table renders inside the shell.
  - Visiting `/ruta-que-no-existe` redirects to `/` (URL becomes the app root; the mail shell renders).
  - Searching from `/settings` (type in the header search, submit) navigates to `/?q=…`.

- [ ] **shortcuts.spec.ts** (authenticated):
  - Pressing `?` opens the shortcuts overlay (dialog named `Atajos`) with the 7 rows; `Esc` closes it; clicking the backdrop closes it.
  - The header `? Atajos` button also opens it.
  - Pressing `/` focuses the search input (assert `document.activeElement` is the search box).

- [ ] **responsive.spec.ts** (authenticated):
  - At 520×800 viewport, `document.documentElement.scrollWidth <= clientWidth` (no horizontal scroll) on `/`, `/settings`.
  - Below `lg`, the CÉFIRO wordmark text is hidden (only the logo shows) — assert the tagline text is not visible while the logo is.

- [ ] **Run + verify** — `cd e2e && bunx playwright test` all green (headless). Fix flaky waits with role/text auto-waiting, never arbitrary sleeps.
- [ ] **Commit** — `test(e2e): mail-independent flow coverage`

---

### Task 3: CI job

**Files:** Modify `.github/workflows/ci.yml`

Add an `e2e` job parallel to `test` (same `postgres` service block copied verbatim). Steps:
- checkout, setup-bun@v2 (1.3), `bun install --frozen-lockfile`.
- `cd e2e && bunx playwright install --with-deps chromium`.
- Run the suite with the CI env: `DATABASE_URL=postgres://webmail:webmail@localhost:5432/webmail`, and whatever build step the config needs (mirror what Task 1 settled on — if the webServer builds the web itself, nothing extra; if a separate build step was chosen, add `bun run --filter @webmail/web build` before the playwright run). Command: `cd e2e && bunx playwright test`.
- Upload the HTML report on failure: `actions/upload-artifact@v4` with `if: failure()`, path `e2e/playwright-report`.

Keep the `publish` job's `needs:` — decide whether it should `needs: [test, e2e]` (block publish on E2E too) or just `test`. Set `needs: [test, e2e]` so a red E2E blocks the staging/prod image. Document this in the commit.

- [ ] **Verify** — `bun -e "require('yaml')"` isn't available; instead validate the YAML by reading it back and confirming structure. Commit — `ci: run playwright e2e on every pr`.

---

### Task 4: Verification sweep

- [ ] `cd e2e && bunx playwright test` — full green locally.
- [ ] Root `bun run typecheck` — clean (incl. e2e).
- [ ] Root `bun run test` — unit suites still green and e2e NOT picked up.
- [ ] `bun install --frozen-lockfile` — lockfile consistent (commit `bun.lock`).
- [ ] Report; commit only if fixes were needed.
