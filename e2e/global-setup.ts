import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// Playwright's test runner executes global-setup under Node.js, not Bun.
// The `@webmail/server/src/...` subpath resolves fine when run directly with
// `bun`, but Node's ESM resolver requires an explicit file extension and
// cannot resolve the extension-less TS subpath through the workspace symlink.
// Falling back to relative imports keeps the real `createSessionStore` (and
// its token/hash format) authoritative without needing a package export map.
import { createDb } from "../apps/server/src/infra/db/client";
import { migrate } from "../apps/server/src/infra/db/migrate";
import { createUsersRepo } from "../apps/server/src/infra/repos/users";
import { createSessionStore } from "../apps/server/src/modules/auth/sessions";

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
