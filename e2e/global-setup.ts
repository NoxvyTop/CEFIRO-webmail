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
import { createSsoConfigRepo } from "../apps/server/src/infra/repos/sso-config";
import { importMasterKey } from "../apps/server/src/modules/credentials/crypto";
import { seedInbox, seedJunk } from "./smtp-seed";
import { SEED_EMAILS, SPAM_SEED_EMAILS } from "./fixtures/mail";
import { ensureArchiveMailbox } from "./jmap-admin";
import {
  IDP_ISSUER_ENV,
  OIDC_ARCHIVED_EMAIL,
  TEST_IDP_CLIENT_ID,
  TEST_IDP_CLIENT_SECRET,
  TEST_IDP_SCOPES,
} from "./oidc-idp";
import {
  SETUP_DATABASE_URL_ENV,
  TEST_DATABASE_URL_ENV,
  createTestDatabase,
  dropTestDatabase,
  isThrowawayDatabase,
  requireBaseDatabaseUrl,
} from "./test-db";

const here = dirname(fileURLToPath(import.meta.url));

// Must match apps/server's MASTER_KEY (also hardcoded in playwright.config.ts's
// webServer.env) so the mailbox credential this seeds is decryptable by the
// running server. Generated, not the readable docker-compose.dev.yml key: that
// server boots with NODE_ENV=production, which refuses published or low-entropy
// keys (GH #223). Throwaway — this database is created and dropped per run.
const MASTER_KEY_B64 = "JdJVpkA5AKBg+8w5V7XOqXnOXGuEgkybDHOvDiVYfJE=";
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

/**
 * Seeds this run's throwaway database and returns the teardown that drops it
 * (Playwright calls a function returned from globalSetup as global teardown).
 *
 * GH #230: this used to fall back to the shared development database, migrate
 * it, write users/sessions/mail credentials into it and never clean up. The
 * database is now created per run — see test-db.ts — so everything below writes
 * into a database that did not exist a moment ago and will not exist a moment
 * after the run.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const baseUrl = requireBaseDatabaseUrl();
  // Minted by playwright.config.ts, which runs in this same process. Absent it,
  // this file is being invoked outside the Playwright runner.
  const url = process.env[TEST_DATABASE_URL_ENV];
  if (!url) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} is not set — global-setup.ts expects to be run by ` +
        "Playwright, whose config (playwright.config.ts) mints the run's throwaway " +
        "database URL and publishes it there.",
    );
  }
  // A no-op when serve.ts already created it; the one that creates it when the
  // webServer was skipped (E2E_BASE_URL, or reuseExistingServer finding a live
  // server). Left alone entirely for a caller-pinned E2E_DATABASE_URL.
  const disposable = isThrowawayDatabase(url);
  if (disposable) await createTestDatabase(baseUrl, url);

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

    // Mail specs need the seeded user's email to match the Stalwart account's
    // email (JMAP Basic auth is keyed on the user's own email), so that address
    // is fixed rather than random when the fixture is in play.
    //
    // It used to be looked up with findByEmail and only created if missing,
    // because the database was shared and not reset between runs (GH #230). The
    // database is created fresh for this run now, so the row cannot already
    // exist and a plain create is both correct and free of cross-run carryover.
    const user = await users.create(
      stalwartUrl
        ? { email: STALWART_ACCOUNT_EMAIL, displayName: "Cefiro Admin" }
        : { email: `e2e-${crypto.randomUUID()}@noxvytop.com`, displayName: "E2E Admin" },
    );
    await sql`update users set role = 'admin' where id = ${user.id}`;
    const { token } = await createSessionStore(sql).create(user.id, 24);

    const masterKey = await importMasterKey(MASTER_KEY_B64);

    // GH #217. The SSO server (playwright.config.ts) reads its identity provider
    // out of the database like a real deployment does — an encrypted sso_config
    // row — rather than from the environment, so tests/oidc-login.spec.ts drives
    // exactly the code path production uses. The issuer is whatever
    // playwright.config.ts bound the test provider to; absent it (an externally
    // supplied E2E_BASE_URL that opted out of the suite's own servers), nothing
    // is seeded and the OIDC spec has no provider to talk to.
    const idpIssuer = process.env[IDP_ISSUER_ENV];
    if (idpIssuer) {
      await createSsoConfigRepo(sql, masterKey).set({
        issuer: idpIssuer,
        clientId: TEST_IDP_CLIENT_ID,
        clientSecret: TEST_IDP_CLIENT_SECRET,
        scopes: TEST_IDP_SCOPES,
      });
      // A user the provider will authenticate but the app must refuse, covering
      // the callback's archived-account branch. Deactivated through the repo
      // rather than inserted inactive because `create` has no such option — the
      // application never creates a user that way either.
      const archived = await users.create({
        email: OIDC_ARCHIVED_EMAIL,
        displayName: "Cuenta archivada",
      });
      await users.setActive(archived.id, false);
    }

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

      await createMailCredentialsRepo(sql, masterKey).set(user.id, STALWART_ACCOUNT_PASSWORD);

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

  // Global teardown. Dropping the database is what makes the suite
  // self-cleaning by construction: every user, session and encrypted mail
  // credential it wrote goes with it, so nothing can be carried into the next
  // run and nothing is left behind in a shared database. A caller-pinned
  // E2E_DATABASE_URL is never dropped — the suite did not create it.
  //
  // The wizard server's database (GH #248) is dropped here too, even though
  // this file never creates or seeds it — serve.ts creates it on boot and
  // nothing else would ever clean it up, and a first-run database that
  // survives the run is a database whose SECOND run is not a first run. The
  // drop is unconditional on the row contents and guarded only by the
  // throwaway-name check, so a caller who pinned E2E_SETUP_DATABASE_URL at a
  // database they own gets it left alone, exactly like the one above.
  const setupUrl = process.env[SETUP_DATABASE_URL_ENV];
  return async () => {
    if (disposable) await dropTestDatabase(baseUrl, url);
    if (setupUrl && isThrowawayDatabase(setupUrl)) await dropTestDatabase(baseUrl, setupUrl);
  };
}
