import { expect, test } from "@playwright/test";
import { seedInbox } from "../smtp-seed";

// Requires the Stalwart fixture + seeded mailbox credential from
// global-setup.ts (gated on E2E_STALWART_URL). Bring up the mail stack first:
//   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
//   docker compose -f docker-compose.e2e.yml up -d --build
//   cd e2e && E2E_STALWART_URL=http://localhost:8096 bunx playwright test tests/mail-actions.spec.ts

// Env-overridable with the same defaults and reasoning as
// global-setup.ts's identically-named constants — see there for why a
// containerized CI job overrides these to reach the fixture by service name.
const STALWART_SMTP_HOST = process.env.STALWART_SMTP_HOST ?? "localhost";
// The TLS ("SMTPS") listener — see e2e/smtp-seed.ts's file header for why
// authenticated, TLS-only submission is required to land seeded mail in the
// Inbox instead of Junk Mail.
const STALWART_SMTP_PORT = Number(process.env.STALWART_SMTP_PORT ?? 8465);

// A dedicated, uniquely-subjected message seeded straight into the Inbox for
// this spec only — NOT one of fixtures/mail.ts's SEED_EMAILS, so archiving it
// out of the Inbox here can't break mail-read.spec.ts's assumption that all
// three SEED_EMAILS subjects stay visible there. Unique per run so re-running
// this suite against the same, never-reset Stalwart fixture always yields
// exactly one matching row before the star/archive actions run.
const SUBJECT = `Star and archive fixture ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.beforeAll(async () => {
  await seedInbox(STALWART_SMTP_HOST, STALWART_SMTP_PORT, [
    {
      messageId: "actions-fixture@partner.test",
      from: "Actions Fixture <actions@partner.test>",
      to: "admin@cefiro.test",
      subject: SUBJECT,
      body: "Fixture message for the star + archive E2E flow.\r\n\r\nSecond paragraph.",
    },
  ]);
});

test("star a message into Destacados, then archive it out of the inbox into Archive", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Scoped to the row WRAPPER, not to the role="option" element (GH #225): an
  // ARIA option must not contain interactive descendants, so the star button
  // was moved out of the option and sits beside it inside the wrapper. Nesting
  // into the option to reach the star therefore resolves to nothing now; the
  // wrapper's data-testid is the stable handle for "this row's controls".
  const row = page.getByTestId("conversation-row").filter({ hasText: SUBJECT });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Destacar" }).click();

  await page.getByRole("button", { name: "Destacados" }).click();
  await expect(page.getByRole("option", { name: new RegExp(SUBJECT) })).toBeVisible();

  // Open it from Destacados and archive it from the reader.
  await page.getByRole("option", { name: new RegExp(SUBJECT) }).click();
  await page.getByTestId("thread-actions-bar").getByRole("button", { name: "Archivar" }).click();

  await expect(page.getByRole("status")).toHaveText(/Correo archivado/);

  // Left the inbox...
  await page.getByRole("button", { name: "Recibidos" }).click();
  await expect(page.getByRole("option", { name: new RegExp(SUBJECT) })).toHaveCount(0);

  // ...and shows up in Archive.
  await page.getByRole("button", { name: "Archivados" }).click();
  await expect(page.getByRole("option", { name: new RegExp(SUBJECT) })).toBeVisible();
});

// Labels require a user keyword on a message. None of the seed fixtures carry
// one, and adding one would only exercise the sidebar label chip already
// covered by apps/web/src/features/mailbox/sidebar-labels.test.tsx and
// label-view.test.tsx — out of scope for this E2E slice.
