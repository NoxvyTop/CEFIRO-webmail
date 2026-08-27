import { expect, test } from "@playwright/test";
import { SETUP_TOKEN_ENV, SETUP_WIZARD_SSO } from "../setup-server";

/**
 * The first-run wizard — GH #248.
 *
 * `apps/web/src/features/setup/SetupPage.tsx` is the screen an operator sees
 * exactly once and the only unauthenticated screen that can mint an
 * administrator, and no spec had ever opened it: it was the worst-covered file
 * in the web package for that reason. It is also unreachable from the suite's
 * other servers by construction — global-setup.ts seeds an admin and an SSO
 * config into their database, which is exactly the pair GH #234's completion
 * latch reads before answering 404 forever.
 *
 * So this project drives a server of its own, on a database nobody seeds (see
 * ../setup-server.ts). That makes the whole arc testable in one pass, in the
 * order a real instance lives it: an open wizard, a saved provider, the first
 * administrator, and then the same wizard shut behind them.
 *
 * The steps are deliberately ONE test rather than four. They are not
 * independent — each one is only reachable from the state the previous one
 * leaves, and the last one is only meaningful because the first three ran — and
 * the suite is serial anyway (`workers: 1`).
 */

const ADMIN_EMAIL = "primera.administradora@cefiro.test";

test("the first run configures SSO, mints the first admin, and closes the wizard behind itself", async ({
  page,
}) => {
  const token = process.env[SETUP_TOKEN_ENV] ?? "";
  expect(token, `${SETUP_TOKEN_ENV} is published by playwright.config.ts`).not.toBe("");

  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Configuración inicial" })).toBeVisible();

  // Nothing is offered before the console token is accepted: the SSO and user
  // forms are not merely disabled, they are not rendered at all.
  await expect(page.getByRole("heading", { name: "Proveedor SSO (OIDC)" })).toHaveCount(0);

  // A wrong token leaves the wizard exactly where it was — the server answers
  // 401 and the page must not advance into the connected phase.
  await page.getByLabel("Contraseña temporal de consola").fill("no-es-el-token-correcto");
  await page.getByRole("button", { name: "Conectar" }).click();
  await expect(page.getByRole("heading", { name: "Proveedor SSO (OIDC)" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Conectar" })).toBeVisible();

  await page.getByLabel("Contraseña temporal de consola").fill(token);
  await page.getByRole("button", { name: "Conectar" }).click();

  // The status line is read from the instance, not assumed: a genuine first run
  // reports no SSO and no users, and if this server had been pointed at a seeded
  // database this is where the spec would say so, instead of failing three
  // steps later for a vaguer reason.
  const status = page.getByText(/SSO configurado:/);
  await expect(status).toContainText("SSO configurado: no");
  await expect(status).toContainText("Usuarios: 0");

  // An invalid issuer never reaches the server — setupSsoSchema requires a URL
  // and SetupPage validates before sending. The wizard has to SAY so rather
  // than silently doing nothing, or an operator retypes a good token forever
  // looking for the problem.
  await page.getByLabel("Issuer", { exact: true }).fill("no-es-una-url");
  await page.getByLabel("Client ID").fill(SETUP_WIZARD_SSO.clientId);
  await page.getByLabel("Client Secret").fill(SETUP_WIZARD_SSO.clientSecret);
  // "Guardar" belongs to the SSO form; the account form's button is "Crear".
  await page.getByRole("button", { name: "Guardar" }).click();
  // GH #271: the wizard now maps errors by code instead of one blanket
  // "Error: revisa los datos" — a client-side invalid issuer is `invalid_body`.
  await expect(page.getByRole("alert")).toHaveText(
    "Revisa los datos: hay campos incompletos o con un formato inválido.",
  );

  await page.getByLabel("Issuer", { exact: true }).fill(SETUP_WIZARD_SSO.issuer);
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Guardado")).toBeVisible();

  // The first administrator. This is the privileged half of the wizard: the
  // role select is what decides whether the account it creates can reach
  // /admin, and creating it is what arms the latch.
  await page.getByLabel("Correo").fill(ADMIN_EMAIL);
  // GH #290 added a "Nombre del proveedor" SSO field, so "Nombre" is no longer
  // unique — pin the account name field exactly.
  await page.getByLabel("Nombre", { exact: true }).fill("Primera Administradora");
  await page.getByLabel("Rol").selectOption("admin");
  await page.getByLabel("Contraseña del buzón").fill("buzon-primera-admin");
  await page.getByRole("button", { name: "Crear" }).click();
  await expect(page.getByText("Usuario creado")).toBeVisible();

  // Creating again must be refused rather than quietly minting a second admin.
  // Note the mechanism: by now an admin exists AND SSO is configured, so the
  // completion latch (GH #234) has already CLOSED the router — the second create
  // is refused with 404 (closed), which surfaces the generic error, not the 409
  // user_exists path. Either way it's refused; we assert the refusal (an alert
  // appears and no second "Usuario creado") without pinning a brittle string.
  // (The generic copy for a closed router is unhelpful — tracked in a follow-up.)
  await page.getByRole("button", { name: "Crear" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Usuario creado")).toHaveCount(0);

  // GH #234, end to end. The instance now has an active admin AND an SSO
  // config, so the setup router is closed — permanently, and to everyone
  // holding the token, which is the whole point: BOOTSTRAP_MODE is still true
  // on this server. A reload starts the wizard over at the token form; the
  // token that worked a moment ago now gets the same 404 a never-enabled
  // instance would answer, and the SPA renders it as "disabled".
  await page.reload();
  await page.getByLabel("Contraseña temporal de consola").fill(token);
  await page.getByRole("button", { name: "Conectar" }).click();
  await expect(page.getByRole("alert")).toHaveText("El modo de configuración está desactivado");
  await expect(page.getByRole("heading", { name: "Proveedor SSO (OIDC)" })).toHaveCount(0);
});
