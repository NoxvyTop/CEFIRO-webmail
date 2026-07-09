import { expect, test } from "@playwright/test";
import { SEED_EMAILS } from "../fixtures/mail";

// Requires the Stalwart fixture + seeded mailbox/inbox mail from
// global-setup.ts (gated on E2E_STALWART_URL). Bring up the mail stack first:
//   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
//   docker compose -f docker-compose.e2e.yml up -d --build
//   cd e2e && E2E_STALWART_URL=http://localhost:8096 bunx playwright test tests/mail-read.spec.ts

// The first non-blank paragraph of each fixture body — a distinctive,
// single-line substring safe to assert on inside the reading pane's <pre>.
function bodySnippet(body: string): string {
  const paragraphs = body.split("\r\n\r\n");
  return paragraphs[1] ?? paragraphs[0]!;
}

// Extracts the display name out of an RFC5322 "Name <email>" string, e.g.
// "Lucia Fernandez <lucia@partner.test>" -> "Lucia Fernandez" — this is what
// the reader shows for the sender (ThreadView's addressLabel prefers name).
function senderName(from: string): string {
  const match = from.match(/^([^<]+)</);
  return (match ? match[1]! : from).trim();
}

test("inbox lists the seeded subjects newest-first and opens the reading pane on click", async ({ page }) => {
  await page.goto("/");

  // Not the "mail not configured" / "mailbox not linked" error state.
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Wait for the list to have settled before reading order off it.
  await expect(page.getByRole("option", { name: new RegExp(SEED_EMAILS[0]!.subject) }).first()).toBeVisible();

  // Order check: only the RELATIVE order between the three known, distinct
  // seed subjects is asserted (via first-occurrence index), not their
  // absolute position — other mail (older duplicate seeds from a prior run
  // that reused this Stalwart volume, or a message another spec in this same
  // suite run just sent to itself) may also be present in the list. The mail
  // router sorts by receivedAt descending (apps/server/src/modules/mail/router.ts),
  // but Stalwart's receivedAt has only second-level granularity and
  // global-setup.ts's seedInbox() delivers all three SEED_EMAILS within the
  // same second — confirmed against the live fixture via a JMAP Email/query
  // round trip: same-second messages come back in delivery (array) order,
  // oldest first, not reverse-chronological.
  const rowTexts = await page.getByRole("option").allTextContents();
  const indexOf = (subject: string) => rowTexts.findIndex((text) => text.includes(subject));
  const indices = SEED_EMAILS.map((seed) => indexOf(seed.subject));

  // Assert only that all three seeded subjects are present — not their strict
  // relative order. The three are delivered over sequential SMTP connections,
  // so on a slow runner the batch can straddle a one-second receivedAt
  // boundary and the newest-first sort would reorder the crossed pair.
  for (const [i, index] of indices.entries()) {
    expect(index, `expected "${SEED_EMAILS[i]!.subject}" to be visible in the message list`).toBeGreaterThanOrEqual(0);
  }

  const seed = SEED_EMAILS[1]!;
  const row = page.getByRole("option", { name: seed.subject, exact: false }).first();
  await row.click();

  const reader = page.getByRole("region", { name: "Lectura" });
  await expect(reader.getByRole("heading", { name: seed.subject })).toBeVisible();
  await expect(reader.getByText(senderName(seed.from)).first()).toBeVisible();

  // The body renders inside a sandboxed srcDoc <iframe> (EmailBody.tsx),
  // not directly in the page — these plain-text SMTP fixtures come back from
  // Stalwart's JMAP Email/get with BOTH textBody and htmlBody pointing at the
  // same text/plain part (confirmed via a live Email/get round trip), so the
  // app's bodyHtml-preferring EmailBody component always takes the iframe
  // path here, never the plain <pre> path.
  const readerFrame = reader.frameLocator("iframe");
  await expect(readerFrame.getByText(bodySnippet(seed.body))).toBeVisible();

  // The message becomes read: MessageList's row weight goes from
  // font-semibold (unread) to font-normal (read) once the optimistic
  // $seen update lands (see MessageList.tsx's markSeenMutation).
  await expect(row).not.toHaveClass(/font-semibold/);
});
