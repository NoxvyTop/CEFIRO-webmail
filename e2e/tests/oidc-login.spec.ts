import { expect, test, type Page } from "@playwright/test";
import {
  IDP_EMAIL_LABEL,
  IDP_EMAIL_VERIFIED_LABEL,
  IDP_HEADING,
  IDP_ISSUER_ENV,
  IDP_SUBMIT_LABEL,
  OIDC_ARCHIVED_EMAIL,
} from "../oidc-idp";

/**
 * The production entry point, driven through a browser: OIDC/SSO against a real
 * (if small) identity provider, including just-in-time provisioning of a user
 * the app has never seen — GH #217.
 *
 * This spec runs on the `sso` project, which points at the second app server
 * playwright.config.ts starts with BOOTSTRAP_MODE off. That is what makes it
 * meaningful: the break-glass form the rest of the suite relies on does not
 * exist here, so the only way in is the one a real deployment offers.
 *
 * Nothing about the server's OIDC implementation is stubbed. Every step below
 * goes through apps/server/src/modules/auth/router.ts and its `oidc.ts` helpers
 * unchanged — PKCE minted and sealed into the state cookie, discovery, the token
 * exchange, and `jose` verifying the id_token's signature against the provider's
 * published JWKS. e2e/oidc-idp.ts documents what the provider checks in return.
 */

// Published by playwright.config.ts onto process.env, which Playwright's worker
// processes inherit — the same channel test-db.ts uses for the run's database.
const IDP_ISSUER = process.env[IDP_ISSUER_ENV];

/** A user the app has never seen, so the login below has to provision one. */
function unknownEmail(): string {
  return `oidc-${crypto.randomUUID()}@cefiro.test`;
}

/**
 * Walks the whole login from the app's own sign-in screen to wherever the flow
 * ends up, and returns nothing — every assertion belongs to the caller, since
 * the interesting difference between these tests is where they land.
 */
async function signInThroughIdp(
  page: Page,
  email: string,
  options: { emailVerified?: boolean } = {},
): Promise<void> {
  await page.goto("/");

  // Present only because this server reports bootstrapMode false: proof the
  // spec is exercising the real entry point and not the emergency form.
  await page.getByRole("link", { name: "Iniciar sesión con SSO" }).click();

  // LoginPage holds a deliberate ~1.4s "Conectando…" beat before navigating, so
  // the wait here is for the provider's own page rather than for a click to
  // settle. Landing on it at all proves GET /api/auth/login discovered the
  // issuer, minted PKCE and redirected with a state the provider accepted.
  await expect(page.getByRole("heading", { name: IDP_HEADING })).toBeVisible({ timeout: 15_000 });
  if (IDP_ISSUER) expect(page.url().startsWith(`${IDP_ISSUER}/authorize`)).toBe(true);

  await page.getByLabel(IDP_EMAIL_LABEL).fill(email);
  if (options.emailVerified === false) {
    await page.getByLabel(IDP_EMAIL_VERIFIED_LABEL).uncheck();
  }
  await page.getByRole("button", { name: IDP_SUBMIT_LABEL }).click();
}

test("signing in through the identity provider provisions an unknown user just in time", async ({
  page,
}) => {
  const email = unknownEmail();

  await signInThroughIdp(page, email);

  // Back on the app, authenticated. The header control is the shell's own
  // evidence that /api/auth/me resolved a session.
  await expect(page.getByRole("button", { name: `Sesión iniciada como ${email}` })).toBeVisible();

  // And the row behind that session is one the callback created: it did not
  // exist anywhere before this test minted the address a moment ago.
  const me = await page.request.get("/api/auth/me");
  expect(me.ok()).toBe(true);
  expect(await me.json()).toMatchObject({
    email,
    // Both fields are the JIT branch's own signature: it derives the display
    // name from the local part and takes the repo's default role, never admin.
    displayName: email.split("@")[0],
    role: "employee",
  });
});

test("a second sign-in reuses the provisioned account instead of creating another", async ({
  page,
}) => {
  const email = unknownEmail();

  await signInThroughIdp(page, email);
  await expect(page.getByRole("button", { name: `Sesión iniciada como ${email}` })).toBeVisible();
  const provisioned = await (await page.request.get("/api/auth/me")).json();

  // Drop the session and come back through the provider as the same person.
  const loggedOut = await page.request.post("/api/auth/logout");
  expect(loggedOut.ok()).toBe(true);

  await signInThroughIdp(page, email);
  await expect(page.getByRole("button", { name: `Sesión iniciada como ${email}` })).toBeVisible();

  // The same user id means the callback took the findByEmail branch, not the
  // JIT one — a duplicate row would surface here as a different id.
  expect(await (await page.request.get("/api/auth/me")).json()).toMatchObject({
    userId: provisioned.userId,
    email,
  });
});

test("an archived account is refused even though the provider authenticates it", async ({
  page,
}) => {
  // Seeded deactivated by global-setup.ts. The provider is happy to issue a
  // valid, correctly signed id_token for it; refusing the login is entirely the
  // app's decision, which is the point of the assertion.
  await signInThroughIdp(page, OIDC_ARCHIVED_EMAIL);

  await expect(page).toHaveURL("/?auth_error=account_archived");
  await expect(page.getByRole("link", { name: "Iniciar sesión con SSO" })).toBeVisible();
  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(401);
});

test("an unverified email is refused", async ({ page }) => {
  await signInThroughIdp(page, unknownEmail(), { emailVerified: false });

  // `jose` verifies the signature and then createIdTokenVerifier rejects the
  // claim set, so the callback's failure path is what runs — not a bad-signature
  // path. The user is never provisioned.
  await expect(page).toHaveURL("/?auth_error=oidc");
  await expect(page.getByRole("alert")).toHaveText("No se pudo completar el inicio de sesión");
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
});

test("a callback whose state does not match the sealed cookie is rejected", async ({ page }) => {
  // No GET /api/auth/login first, so there is no oidc_state cookie to open —
  // the shape a stolen or replayed callback URL arrives in.
  await page.goto("/api/auth/callback?code=forged-code&state=forged-state");

  await expect(page).toHaveURL("/?auth_error=state");
  await expect(page.getByRole("alert")).toHaveText("La sesión de inicio expiró, inténtalo de nuevo");
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
});
