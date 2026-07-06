# F1 Plan 1/4 — Foundation & Walking Skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootable monorepo skeleton: Bun+Hono BFF with error envelope/traceId/structured logs, PostgreSQL with full F1 schema, credential crypto module, React SPA shell with i18n, Docker image and CI publishing to GHCR.

**Architecture:** Monorepo (`apps/web`, `apps/server`, `packages/shared`). BFF is a thin Hono app; external systems live behind `infra/` adapters. Shared Zod contracts validate front↔back at compile time and runtime. See `docs/ARCHITECTURE.md` (Spanish) for the approved design.

**Tech Stack:** Bun 1.2+, Hono 4, TypeScript 5 (strict), Zod, postgres.js, React 19, Vite 6, Tailwind CSS 4, TanStack Query 5, i18next, Vitest 3, Docker, GitHub Actions.

## Global Constraints

- All code, identifiers, comments, commit messages, and UI copy: **English**. UI copy only through i18n keys (catalogs: `es`, `en`; default locale `es`, fallback `en`).
- **Zero runtime internet access**: no CDNs, self-hosted fonts (`@fontsource-variable/inter`), all deps resolved at build time and pinned by `bun.lock` (commit it).
- **Runtime-agnostic backend**: Web APIs only (fetch, crypto.subtle, streams) in `modules/` and `core/`; Bun-specific APIs allowed only in entry point and `infra/` adapters.
- Credentials or secrets must never appear in logs or test fixtures with real values.
- Conventional commits, no AI attribution.
- Every task runs `bun run typecheck` and its tests before committing.
- Work on branch `init-desarollo`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.editorconfig`
- Modify: `.gitignore` (append coverage/dist entries if missing)

**Interfaces:**
- Produces: Bun workspaces `apps/*`, `packages/*`; root scripts `typecheck` and `test` that fan out to workspaces; `tsconfig.base.json` all packages extend.

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "webmail",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "typecheck": "bun run --filter '*' typecheck",
    "test": "bun run --filter '*' test"
  }
}
```

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 3: Create .editorconfig**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

- [ ] **Step 4: Append build artifacts to .gitignore** (only lines not already present)

```
coverage/
*.tsbuildinfo
```

- [ ] **Step 5: Verify**

Run: `bun install`
Expected: succeeds, creates `bun.lock` (empty workspaces are fine).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .editorconfig .gitignore bun.lock
git commit -m "chore: scaffold bun monorepo"
```

---

### Task 2: Shared contracts package

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/api/envelope.ts`
- Test: `packages/shared/src/api/envelope.test.ts`

**Interfaces:**
- Produces: `@webmail/shared` exporting `apiErrorSchema`, `ApiError { code: string; message: string; traceId: string }`, `healthResponseSchema`, `HealthResponse { status: "ok" | "degraded"; checks: Record<string, boolean> }`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@webmail/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.24.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/shared/src/api/envelope.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "./envelope";

describe("apiErrorSchema", () => {
  it("accepts a valid error envelope", () => {
    const parsed = apiErrorSchema.parse({
      code: "not_found",
      message: "errors.not_found",
      traceId: "trace-1",
    });
    expect(parsed.code).toBe("not_found");
  });

  it("rejects an envelope without traceId", () => {
    expect(() =>
      apiErrorSchema.parse({ code: "x", message: "errors.x" }),
    ).toThrow();
  });
});

describe("healthResponseSchema", () => {
  it("accepts ok status with checks", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      checks: { postgres: true },
    });
    expect(parsed.checks.postgres).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(() =>
      healthResponseSchema.parse({ status: "broken", checks: {} }),
    ).toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/shared && bun install && bunx vitest run`
Expected: FAIL — cannot resolve `./envelope`.

- [ ] **Step 5: Implement** — `packages/shared/src/api/envelope.ts`

```ts
import { z } from "zod";

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  traceId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.record(z.string(), z.boolean()),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
```

And `packages/shared/src/index.ts`:

```ts
export * from "./api/envelope";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bunx vitest run` (inside `packages/shared`)
Expected: 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared bun.lock
git commit -m "feat(shared): add api error and health contracts"
```

---

### Task 3: Server skeleton — Hono app, traceId, error envelope, logger

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/core/errors.ts`, `apps/server/src/core/logger.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `HealthResponse` from `@webmail/shared`.
- Produces: `createApp(): Hono` (used by every later server task to mount routes); `DomainError(code, httpStatus, messageKey)`; `log(level, msg, fields)`; Hono context variable `traceId: string`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@webmail/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@webmail/shared": "workspace:*",
    "hono": "^4.6.0",
    "postgres": "^3.4.0",
    "zod": "^3.24.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["bun"] },
  "include": ["src"]
}
```

Add `"@types/bun": "^1.2.0"` to devDependencies (needed only by `index.ts` entry).

- [ ] **Step 3: Write the failing test** — `apps/server/src/app.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "@webmail/shared";
import { createApp } from "./app";

describe("app", () => {
  it("returns health with a trace header", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-trace-id")).toBeTruthy();
    expect(healthResponseSchema.parse(await res.json()).status).toBe("ok");
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await createApp().request("/api/nope");
    expect(res.status).toBe(404);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.code).toBe("not_found");
    expect(body.message).toBe("errors.not_found");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/server && bun install && bunx vitest run`
Expected: FAIL — cannot resolve `./app`.

- [ ] **Step 5: Implement errors, logger, app**

`apps/server/src/core/errors.ts`:

```ts
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly messageKey: string,
  ) {
    super(messageKey);
    this.name = "DomainError";
  }
}
```

`apps/server/src/core/logger.ts`:

```ts
type Level = "info" | "warn" | "error";

export function log(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
```

`apps/server/src/app.ts`:

```ts
import { Hono } from "hono";
import type { HealthResponse } from "@webmail/shared";
import { DomainError } from "./core/errors";
import { log } from "./core/logger";

type Env = { Variables: { traceId: string } };

export function createApp() {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set("traceId", traceId);
    c.header("x-trace-id", traceId);
    await next();
  });

  app.get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok", checks: {} };
    return c.json(body);
  });

  app.notFound((c) =>
    c.json(
      { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
      404,
    ),
  );

  app.onError((err, c) => {
    const traceId = c.get("traceId") ?? "unknown";
    if (err instanceof DomainError) {
      log("warn", "domain error", { traceId, code: err.code });
      return c.json(
        { code: err.code, message: err.messageKey, traceId },
        err.httpStatus as 400,
      );
    }
    log("error", "unhandled error", { traceId, error: String(err) });
    return c.json(
      { code: "internal", message: "errors.internal", traceId },
      500,
    );
  });

  return app;
}
```

`apps/server/src/index.ts` (Bun entry — the only Bun-aware file):

```ts
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8080);
const app = createApp();

console.log(JSON.stringify({ level: "info", msg: "server started", port }));

export default { port, fetch: app.fetch };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bunx vitest run` (inside `apps/server`)
Expected: 2 tests PASS.

- [ ] **Step 7: Smoke-run the server**

Run: `bun src/index.ts` then `curl -i http://localhost:8080/api/health`
Expected: 200, JSON body, `x-trace-id` header. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add apps/server bun.lock
git commit -m "feat(server): add hono skeleton with error envelope and trace ids"
```

---

### Task 4: PostgreSQL — dev compose, migration runner, full F1 schema

**Files:**
- Create: `docker-compose.dev.yml`, `.env.example`, `apps/server/src/infra/db/client.ts`, `apps/server/src/infra/db/migrate.ts`, `apps/server/migrations/0001_initial.sql`, `apps/server/src/infra/db/health.ts`
- Modify: `apps/server/src/app.ts` (health check accepts optional db check), `apps/server/package.json` (add `migrate` script)
- Test: `apps/server/src/infra/db/migrate.test.ts`

**Interfaces:**
- Consumes: `createApp()` from Task 3.
- Produces: `createDb(url: string): Sql` (postgres.js instance); `migrate(sql: Sql, dir: string): Promise<void>` (idempotent); `checkDb(sql: Sql): Promise<boolean>`; tables `users`, `mail_credentials`, `signatures`, `user_preferences`, `sessions`, `audit_log`, `sso_config`, `integrations`.

- [ ] **Step 1: Create docker-compose.dev.yml**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: webmail
      POSTGRES_PASSWORD: webmail
      POSTGRES_DB: webmail
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

- [ ] **Step 2: Create .env.example**

```ini
# Local development template. Copy to .env — never commit .env.
DATABASE_URL=postgres://webmail:webmail@localhost:5432/webmail
PORT=8080
```

- [ ] **Step 3: Start Postgres**

Run: `docker compose -f docker-compose.dev.yml up -d`
Expected: postgres container healthy.

- [ ] **Step 4: Write the failing test** — `apps/server/src/infra/db/migrate.test.ts`

```ts
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrate } from "./migrate";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5432/webmail";
const sql = createDb(url);
const dir = fileURLToPath(new URL("../../../migrations", import.meta.url));

afterAll(() => sql.end());

describe("migrate", () => {
  it("creates the full F1 schema and is idempotent", async () => {
    await migrate(sql, dir);
    await migrate(sql, dir); // second run must be a no-op

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `;
    const names = tables.map((t) => t.table_name);
    for (const expected of [
      "users",
      "mail_credentials",
      "signatures",
      "user_preferences",
      "sessions",
      "audit_log",
      "sso_config",
      "integrations",
      "schema_migrations",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bunx vitest run src/infra/db` (inside `apps/server`)
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 6: Implement client, migrator, schema**

`apps/server/src/infra/db/client.ts`:

```ts
import postgres from "postgres";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  return postgres(url, { max: 10, onnotice: () => {} });
}
```

`apps/server/src/infra/db/migrate.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client";

export async function migrate(sql: Db, dir: string): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await sql`select 1 from schema_migrations where name = ${file}`;
    if (applied.length > 0) continue;
    const body = await readFile(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
  }
}
```

`apps/server/migrations/0001_initial.sql`:

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role text not null default 'employee' check (role in ('employee', 'admin')),
  locale text not null default 'es',
  created_at timestamptz not null default now()
);

create table mail_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table signatures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  content_html text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  preferences jsonb not null default '{}'
);

create table sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_expires_at_idx on sessions (expires_at);

create table audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  target text,
  ip text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on audit_log (created_at);

create table sso_config (
  id integer primary key default 1 check (id = 1),
  issuer text not null,
  client_id text not null,
  client_secret_ciphertext bytea not null,
  client_secret_iv bytea not null,
  key_version integer not null default 1,
  scopes text not null default 'openid profile email',
  updated_at timestamptz not null default now()
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  config jsonb not null default '{}',
  secrets_ciphertext bytea,
  secrets_iv bytea,
  key_version integer,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);
```

`apps/server/src/infra/db/health.ts`:

```ts
import type { Db } from "./client";

export async function checkDb(sql: Db): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 7: Wire db check into health route.** In `apps/server/src/app.ts`, change `createApp` to accept optional checks and update the route:

```ts
export type HealthCheck = () => Promise<boolean>;

export function createApp(checks: Record<string, HealthCheck> = {}) {
  // ... middleware unchanged ...

  app.get("/api/health", async (c) => {
    const results: Record<string, boolean> = {};
    for (const [name, check] of Object.entries(checks)) {
      results[name] = await check();
    }
    const body: HealthResponse = {
      status: Object.values(results).every(Boolean) ? "ok" : "degraded",
      checks: results,
    };
    return c.json(body);
  });

  // ... notFound / onError unchanged ...
}
```

And in `index.ts`, when `DATABASE_URL` is set:

```ts
import { createApp } from "./app";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";

const port = Number(process.env.PORT ?? 8080);
const dbUrl = process.env.DATABASE_URL;
const db = dbUrl ? createDb(dbUrl) : undefined;
const app = createApp(db ? { postgres: () => checkDb(db) } : {});

export default { port, fetch: app.fetch };
```

Add migrate script to `apps/server/package.json` scripts:

```json
"migrate": "bun run scripts/migrate.ts"
```

with `apps/server/scripts/migrate.ts`:

```ts
import { fileURLToPath } from "node:url";
import { createDb } from "../src/infra/db/client";
import { migrate } from "../src/infra/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = createDb(url);
await migrate(sql, fileURLToPath(new URL("../migrations", import.meta.url)));
await sql.end();
console.log("migrations applied");
```

- [ ] **Step 8: Run all server tests**

Run: `bunx vitest run` (inside `apps/server`, Postgres up)
Expected: app tests + migrate test PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server docker-compose.dev.yml .env.example bun.lock
git commit -m "feat(server): add postgres client, migration runner and f1 schema"
```

---

### Task 5: Credential crypto module (AES-256-GCM, Web Crypto)

**Files:**
- Create: `apps/server/src/modules/credentials/crypto.ts`, `apps/server/scripts/generate-master-key.ts`
- Test: `apps/server/src/modules/credentials/crypto.test.ts`

**Interfaces:**
- Produces: `importMasterKey(base64: string): Promise<CryptoKey>`; `encryptSecret(key: CryptoKey, plaintext: string): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }>`; `decryptSecret(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array): Promise<string>`. Used later by mail credentials, sso_config and integrations secrets.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/credentials/crypto.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, importMasterKey } from "./crypto";

function randomKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

describe("credential crypto", () => {
  it("round-trips a secret", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "mailbox-password");
    expect(await decryptSecret(key, ciphertext, iv)).toBe("mailbox-password");
  });

  it("produces different ciphertexts for the same plaintext", async () => {
    const key = await importMasterKey(randomKeyB64());
    const a = await encryptSecret(key, "same");
    const b = await encryptSecret(key, "same");
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("fails on tampered ciphertext", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "secret");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    await expect(decryptSecret(key, ciphertext, iv)).rejects.toThrow();
  });

  it("fails with the wrong key", async () => {
    const keyA = await importMasterKey(randomKeyB64());
    const keyB = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(keyA, "secret");
    await expect(decryptSecret(keyB, ciphertext, iv)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importMasterKey(btoa("short"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/modules/credentials` (inside `apps/server`)
Expected: FAIL — cannot resolve `./crypto`.

- [ ] **Step 3: Implement** — `apps/server/src/modules/credentials/crypto.ts`

```ts
const ALGO = "AES-GCM";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export async function importMasterKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, ALGO, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: new Uint8Array(encrypted), iv };
}

export async function decryptSecret(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plain);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/modules/credentials`
Expected: 5 tests PASS.

- [ ] **Step 5: Add key generator script** — `apps/server/scripts/generate-master-key.ts`

```ts
const raw = crypto.getRandomValues(new Uint8Array(32));
console.log(btoa(String.fromCharCode(...raw)));
```

Run once to verify it prints a 44-char base64 string: `bun scripts/generate-master-key.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/credentials apps/server/scripts/generate-master-key.ts
git commit -m "feat(server): add aes-256-gcm credential crypto module"
```

---

### Task 6: Web SPA skeleton — Vite, Tailwind, i18n, health status

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/index.css`, `apps/web/src/app/App.tsx`, `apps/web/src/app/i18n.ts`, `apps/web/src/app/locales/en.json`, `apps/web/src/app/locales/es.json`, `apps/web/src/test/setup.ts`
- Test: `apps/web/src/app/App.test.tsx`

**Interfaces:**
- Consumes: `GET /api/health` (Task 3/4 shape, validated with `healthResponseSchema` from `@webmail/shared`).
- Produces: app shell with i18n initialized (default `es`, fallback `en`) that later plans extend with `features/` folders.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@webmail/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource-variable/inter": "^5.1.0",
    "@tanstack/react-query": "^5.60.0",
    "@webmail/shared": "workspace:*",
    "i18next": "^24.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-i18next": "^15.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create config files**

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM"] },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": "http://localhost:8080" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
  },
});
```

Add at the top `/// <reference types="vitest/config" />` so the `test` key typechecks.

`apps/web/index.html`:

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NoxvyTop Mail</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`:

```css
@import "tailwindcss";

body {
  font-family: "Inter Variable", system-ui, sans-serif;
}
```

`apps/web/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Create i18n and locales**

`apps/web/src/app/locales/en.json`:

```json
{
  "app": { "title": "NoxvyTop Mail" },
  "health": { "ok": "Service running", "degraded": "Service degraded" }
}
```

`apps/web/src/app/locales/es.json`:

```json
{
  "app": { "title": "Correo NoxvyTop" },
  "health": { "ok": "Servicio operativo", "degraded": "Servicio degradado" }
}
```

`apps/web/src/app/i18n.ts`:

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: "es",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
```

- [ ] **Step 4: Write the failing test** — `apps/web/src/app/App.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "./i18n";
import { App } from "./App";

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("shows the app title in Spanish and health status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", checks: { postgres: true } })),
      ),
    );
    renderApp();
    expect(screen.getByText("Correo NoxvyTop")).toBeInTheDocument();
    expect(await screen.findByText("Servicio operativo")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd apps/web && bun install && bunx vitest run`
Expected: FAIL — cannot resolve `./App`.

- [ ] **Step 6: Implement App and entry**

`apps/web/src/app/App.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { healthResponseSchema } from "@webmail/shared";

async function fetchHealth() {
  const res = await fetch("/api/health");
  return healthResponseSchema.parse(await res.json());
}

export function App() {
  const { t } = useTranslation();
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">{t("app.title")}</h1>
      {health.data && (
        <p className="text-sm text-gray-500">
          {t(health.data.status === "ok" ? "health.ok" : "health.degraded")}
        </p>
      )}
    </main>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import "@fontsource-variable/inter";
import "./index.css";
import "./app/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

const client = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bunx vitest run` (inside `apps/web`)
Expected: 1 test PASS.

- [ ] **Step 8: Verify the dev stack manually**

Run server (`bun src/index.ts` in `apps/server`) and web (`bunx vite` in `apps/web`), open `http://localhost:5173`.
Expected: title "Correo NoxvyTop" and "Servicio operativo" (with Postgres up).

- [ ] **Step 9: Commit**

```bash
git add apps/web bun.lock
git commit -m "feat(web): add react spa shell with i18n and health status"
```

---

### Task 7: Serve the built SPA from the BFF (production mode)

**Files:**
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: `apps/web/dist` build output; `createApp()` from Task 3.
- Produces: single production container entry — API and static SPA on one port, SPA fallback to `index.html` for client-side routes.

- [ ] **Step 1: Add static serving to the entry point** — `apps/server/src/index.ts`:

```ts
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";

const port = Number(process.env.PORT ?? 8080);
const dbUrl = process.env.DATABASE_URL;
const db = dbUrl ? createDb(dbUrl) : undefined;
const app = createApp(db ? { postgres: () => checkDb(db) } : {});

if (process.env.NODE_ENV === "production") {
  const root = process.env.STATIC_DIR ?? "../web/dist";
  app.use("*", serveStatic({ root }));
  app.use("*", serveStatic({ root, path: "index.html" }));
}

export default { port, fetch: app.fetch };
```

Note: `hono/bun`'s `serveStatic` is a Bun-specific import — allowed here because `index.ts` is the entry point (infra boundary).

- [ ] **Step 2: Verify manually**

```bash
cd apps/web && bunx vite build
cd ../server && NODE_ENV=production bun src/index.ts
```

Open `http://localhost:8080` — expected: the SPA renders and `/api/health` still answers JSON. (On Windows PowerShell set `$env:NODE_ENV="production"` first.)

- [ ] **Step 3: Run all tests still green**

Run: `bun run test` (repo root)
Expected: shared, server and web suites PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): serve built spa in production mode"
```

---

### Task 8: Docker image + CI to GHCR

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above; CI runs root `typecheck` and `test`.
- Produces: image `ghcr.io/noxvytop/webmail` — tag `staging` from `preproduc`, tag `latest` from `main`. Egress rule satisfied: all deps baked at build, runtime pulls nothing.

- [ ] **Step 1: Create .dockerignore**

```
node_modules
**/node_modules
.git
docs
coverage
.env
```

- [ ] **Step 2: Create Dockerfile**

```dockerfile
FROM oven/bun:1.2 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web && bunx vite build

FROM oven/bun:1.2-slim
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
USER bun
EXPOSE 8080
CMD ["bun", "apps/server/src/index.ts"]
```

- [ ] **Step 3: Build and smoke-test locally**

```bash
docker build -t webmail:dev .
docker run --rm -p 8080:8080 webmail:dev
```

Expected: `http://localhost:8080` serves the SPA; `/api/health` returns `{"status":"ok","checks":{}}` (no DATABASE_URL in this smoke test).

- [ ] **Step 4: Create CI workflow** — `.github/workflows/ci.yml`

```yaml
name: ci

on:
  push:
    branches: [init-desarollo, preproduc, main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: webmail
          POSTGRES_PASSWORD: webmail
          POSTGRES_DB: webmail
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U webmail"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.2"
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test
        env:
          DATABASE_URL: postgres://webmail:webmail@localhost:5432/webmail

  publish:
    if: github.event_name == 'push' && (github.ref_name == 'preproduc' || github.ref_name == 'main')
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/noxvytop/webmail:${{ github.ref_name == 'main' && 'latest' || 'staging' }}
```

- [ ] **Step 5: Commit and push, verify CI**

```bash
git add Dockerfile .dockerignore .github/workflows/ci.yml
git commit -m "ci: add docker image and github actions pipeline to ghcr"
git push
```

Expected: `test` job green on GitHub Actions for `init-desarollo` (publish job skipped — correct, it only runs for preproduc/main).

---

## Out of Scope (later plans)

- Plan 2: OIDC login from `sso_config`, sessions, bootstrap/recovery mode, setup screen.
- Plan 3: JMAP proxy, folders, message list, thread view, labels, search, SSE notifications.
- Plan 4: composer, identities, signatures, send, attachments with preview.
