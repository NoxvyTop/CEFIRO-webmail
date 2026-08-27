/**
 * The vocabulary of the first-run wizard server — GH #248.
 *
 * tests/setup-wizard.spec.ts covers `apps/web/src/features/setup/SetupPage.tsx`,
 * which no spec reached before: it is the screen an operator sees exactly once,
 * on an instance that has no administrator yet, and it is the screen that can
 * mint one. Nothing about it is exercised by the suite's other servers — the
 * default one is seeded with an admin and an SSO config in global-setup.ts,
 * which is precisely the pair GH #234's completion latch reads to shut the setup
 * router for good. Against that database the wizard answers 404 by design.
 *
 * So the wizard gets its own app server on its own unseeded database (see
 * SETUP_DATABASE_URL_ENV in test-db.ts). That is also what makes the LATCH
 * testable end to end rather than only in the server's unit suite: the spec
 * walks the instance from "no admin, no SSO" to "both", and then finds the same
 * wizard closed behind it.
 *
 * These constants live in their own module rather than in playwright.config.ts
 * so the spec can import them without importing the config — the same shape the
 * OIDC vocabulary uses in oidc-idp.ts.
 */

/** Carries the wizard server's base URL from the config to the spec. */
export const SETUP_BASE_URL_ENV = "E2E_SETUP_BASE_URL";

/** Carries the wizard server's break-glass credential to the spec. */
export const SETUP_TOKEN_ENV = "E2E_SETUP_TOKEN";

/**
 * The setup API's token and the bootstrap login's password, one secret for both
 * (apps/server/src/modules/setup/bootstrap.ts). Supplied rather than generated
 * since GH #235, and refused below 24 characters by core/config.ts — this one is
 * 32, and deliberately distinct from the default server's so a spec that reaches
 * the wrong instance fails loudly instead of authenticating against it.
 *
 * Not a secret worth protecting: the server holding it is created and destroyed
 * inside a single Playwright run, against a database that outlives it by nothing.
 */
export const SETUP_TOKEN = "e2e-setup-console-token-01234567";

/** The SSO provider the wizard configures. Never contacted — the spec only
 * checks that the wizard persisted it, which is what closes the latch. */
export const SETUP_WIZARD_SSO = {
  issuer: "https://id.wizard.test",
  clientId: "cefiro-wizard",
  clientSecret: "wizard-client-secret",
  scopes: "openid profile email",
};
