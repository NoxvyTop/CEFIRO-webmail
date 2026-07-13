import { expect, test } from "@playwright/test";
import { SEED_EMAILS } from "../fixtures/mail";

// This spec requires the Stalwart fixture running and reachable, and the
// seeded mailbox credential + inbox mail from global-setup.ts (both gated on
// E2E_STALWART_URL being set). Bring up the mail stack first, then run:
//   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
//   docker compose -f docker-compose.e2e.yml up -d --build
//   cd e2e && E2E_STALWART_URL=http://localhost:8096 bunx playwright test tests/mail-connect.spec.ts

// The first non-blank paragraph of each fixture body — a distinctive,
// single-line substring safe to assert on inside the reading pane's <pre>.
function bodySnippet(body: string): string {
  const paragraphs = body.split("\r\n\r\n");
  return paragraphs[1] ?? paragraphs[0]!;
}

test("authenticated inbox connects to Stalwart and shows the seeded mail", async ({ page }) => {
  await page.goto("/");

  // Not the "mail not configured" / "mailbox not linked" error state — that
  // renders as a role="alert" inside the message list region instead of the
  // actual inbox.
  await expect(page.getByRole("alert")).toHaveCount(0);

  // .first() throughout: global-setup reseeds on every run without resetting
  // the Stalwart container's data (each seedInbox() call uses a fresh
  // per-run Message-ID so repeats always land as new messages rather than
  // being deduplicated — see smtp-seed.ts), so re-running the suite against
  // an already-seeded fixture can leave more than one copy of each subject.
  // At least one match is exactly what these assertions require.
  for (const seed of SEED_EMAILS) {
    await expect(page.getByRole("option", { name: new RegExp(seed.subject) }).first()).toBeVisible();
  }

  const seed = SEED_EMAILS[0]!;
  await page.getByRole("option", { name: new RegExp(seed.subject) }).first().click();

  await expect(page.getByRole("heading", { name: seed.subject })).toBeVisible();
  await expect(page.getByText(bodySnippet(seed.body)).first()).toBeVisible();
});
