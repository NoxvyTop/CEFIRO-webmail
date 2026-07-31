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
import { createMailCredentialsRepo } from "../apps/server/src/infra/repos/mail-credentials";
import { importMasterKey } from "../apps/server/src/modules/credentials/crypto";
import { seedInbox, seedJunk } from "./smtp-seed";
import { SEED_EMAILS, SPAM_SEED_EMAILS } from "./fixtures/mail";
import { ensureArchiveMailbox } from "./jmap-admin";

const here = dirname(fileURLToPath(import.meta.url));

// Must match apps/server's MASTER_KEY (also hardcoded in playwright.config.ts's
// webServer.env) so the mailbox credential this seeds is decryptable by the
// running server.
const MASTER_KEY_B64 = "ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE=";
// Baked into the e2e/stalwart fixture (see e2e/stalwart/README.md) — only
// valid for this local/E2E fixture, never production credentials.
const STALWART_ACCOUNT_EMAIL = "admin@cefiro.test";
const STALWART_ACCOUNT_PASSWORD = "n2BODWVsupeXnJ3L";
// Env-overridable, defaulting to docker-compose.e2e.yml's host-published
// ports so local development and that compose file keep working unchanged.
// A containerized CI job reaches the fixture as a `services:` container
// instead — sharing a network with it and addressing it by service name on
// its own container-native ports (STALWART_SMTP_HOST=stalwart,
// STALWART_SMTP_PORT=465, STALWART_SMTP_PLAIN_PORT=25) rather than the
// host-published 8465/8025 docker-compose.e2e.yml uses.
const STALWART_SMTP_HOST = process.env.STALWART_SMTP_HOST ?? "localhost";
// The TLS ("SMTPS") listener, not plain port 8025 — see smtp-seed.ts for why
// authenticated, TLS-only submission is required to land seeded mail in the
// Inbox instead of Junk Mail.
const STALWART_SMTP_PORT = Number(process.env.STALWART_SMTP_PORT ?? 8465);
// Plain, unauthenticated SMTP listener — used only for SPAM_SEED_EMAILS via
// seedJunk, which relies on the lack of AUTH/TLS to trigger Stalwart's spam
// classifier (see smtp-seed.ts's file header).
const STALWART_SMTP_PLAIN_PORT = Number(process.env.STALWART_SMTP_PLAIN_PORT ?? 8025);

export default async function globalSetup() {
  const url =
    process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
  const sql = createDb(url);
  try {
    await migrate(sql, resolve(here, "../apps/server/migrations"));
    const users = createUsersRepo(sql);

    // Deliberately read the raw env var (no "?? http://localhost:8096"
    // default here, unlike playwright.config.ts's webServer.env): that
    // default only enables the app's mail *router*, but this global setup
    // also seeds a mailbox credential and injects SMTP mail, which requires
    // the Stalwart fixture to actually be running
    // (docker compose -f docker-compose.e2e.yml up -d --build). Gating on an
    // explicit E2E_STALWART_URL keeps `bunx playwright test` (no env var set)
    // working exactly as before this task for every non-mail spec.
    const stalwartUrl = process.env.E2E_STALWART_URL;

    let user: Awaited<ReturnType<typeof users.create>>;
    if (stalwartUrl) {
      // Mail specs need the seeded user's email to match the Stalwart
      // account's email (JMAP Basic auth is keyed on the user's own email),
      // so reuse the same row across runs instead of minting a fresh random
      // address every time — the dev/CI Postgres this points at isn't reset
      // between E2E runs.
      user =
        (await users.findByEmail(STALWART_ACCOUNT_EMAIL)) ??
        (await users.create({ email: STALWART_ACCOUNT_EMAIL, displayName: "Cefiro Admin" }));
    } else {
      const email = `e2e-${crypto.randomUUID()}@noxvytop.com`;
      user = await users.create({ email, displayName: "E2E Admin" });
    }
    await sql`update users set role = 'admin' where id = ${user.id}`;
    const { token } = await createSessionStore(sql).create(user.id, 24);

    if (stalwartUrl) {
      // The Docker healthcheck only proves the Stalwart binary is running,
      // not that its JMAP HTTP listener has finished binding — so a single
      // unretried fetch here can flake immediately after `docker compose up`.
      // Retry for a few seconds, accepting ANY HTTP response (even a 401 or
      // 307) as proof the listener is up; only a connection failure on every
      // attempt is a real problem.
      const JMAP_CHECK_ATTEMPTS = 20;
      const JMAP_CHECK_DELAY_MS = 750;
      let reachable = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= JMAP_CHECK_ATTEMPTS; attempt += 1) {
        try {
          await fetch(`${stalwartUrl}/.well-known/jmap`);
          reachable = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < JMAP_CHECK_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, JMAP_CHECK_DELAY_MS));
          }
        }
      }
      if (!reachable) {
        throw new Error(
          `Stalwart is not reachable at ${stalwartUrl}/.well-known/jmap after ${JMAP_CHECK_ATTEMPTS} attempts — bring up the mail fixture first:\n` +
            `  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\n` +
            `  docker compose -f docker-compose.e2e.yml up -d --build\n` +
            `Original error: ${String(lastError)}`,
        );
      }

      const key = await importMasterKey(MASTER_KEY_B64);
      await createMailCredentialsRepo(sql, key).set(user.id, STALWART_ACCOUNT_PASSWORD);

      await seedInbox(STALWART_SMTP_HOST, STALWART_SMTP_PORT, SEED_EMAILS);

      // Spam/promotional fixtures (GH #137) — delivered unauthenticated on
      // plain port 25 so Stalwart's real spam filter classifies them into
      // Junk Mail instead of forcing a mailbox assignment. Unblocks manual
      // and future E2E coverage of the Junk folder, long-message truncation
      // (GH #135), and the sender-authenticity indicator (GH #136). Kept
      // separate from seedInbox above so SEED_EMAILS/mail-connect.spec.ts's
      // Inbox assertions are unaffected.
      await seedJunk(STALWART_SMTP_HOST, STALWART_SMTP_PLAIN_PORT, SPAM_SEED_EMAILS);

      // The mail-actions spec needs an "Archivar" target mailbox, but this
      // fixture's baked-in account has no archive-role mailbox by default —
      // see jmap-admin.ts for why this is provisioned here via JMAP rather
      // than expected to already exist.
      await ensureArchiveMailbox(stalwartUrl, STALWART_ACCOUNT_EMAIL, STALWART_ACCOUNT_PASSWORD);
    }

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
