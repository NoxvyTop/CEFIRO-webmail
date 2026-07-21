import { expect, test } from "@playwright/test";

// Requires the Stalwart fixture + seeded mailbox credential from
// global-setup.ts (gated on E2E_STALWART_URL). Bring up the mail stack first:
//   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
//   docker compose -f docker-compose.e2e.yml up -d --build
//   cd e2e && E2E_STALWART_URL=http://localhost:8096 bunx playwright test tests/mail-compose.spec.ts

test("compose and send a self-addressed email, then find it in Sent", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "Redactar" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuevo mensaje" });
  await expect(dialog).toBeVisible();

  // The From identity is real: the seeded admin@cefiro.test account's own
  // JMAP identity, pre-selected as the composer's default (Composer.tsx's
  // <select> renders `${identity.name} <${identity.email}>`).
  const fromSelect = dialog.getByRole("combobox", { name: "De" });
  await expect(fromSelect.locator("option:checked")).toHaveText(/admin@cefiro\.test/);

  const to = dialog.getByRole("textbox", { name: "Para" });
  await to.fill("admin@cefiro.test");
  await to.press("Enter");

  // Unique per run so re-running this suite against the same, never-reset
  // Stalwart fixture never collides with (or gets deduplicated against) a
  // previous run's sent copy of the same subject.
  const subject = `E2E compose ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await dialog.getByRole("textbox", { name: "Asunto" }).fill(subject);
  await dialog.getByRole("textbox", { name: "Mensaje" }).fill("Automated end-to-end compose test body.");

  await dialog.getByRole("button", { name: "Enviar" }).click();

  await expect(page.getByRole("status")).toHaveText("Correo enviado");
  await expect(dialog).toBeHidden();

  // Self-send (To === the sending identity) keeps the round trip fully local
  // to this account rather than depending on outbound delivery elsewhere;
  // the sender's own copy always lands in Sent regardless of how Stalwart
  // chooses to handle the inbound leg, which is the deterministic mailbox to
  // assert on here.
  await page.getByRole("button", { name: "Enviados" }).click();
  await expect(page.getByRole("option", { name: new RegExp(subject) }).first()).toBeVisible();
});
