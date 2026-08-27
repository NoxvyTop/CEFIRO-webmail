// Entry point for the test identity provider (oidc-idp.ts), started by
// Playwright as one of the suite's `webServer` processes — GH #217.
//
// A separate process rather than a server started inside global-setup.ts for
// two reasons: `Bun.serve` needs a Bun runtime and Playwright executes
// global-setup under Node, and Playwright already owns the lifecycle of a
// `webServer` (it waits for readiness and kills it on exit) which is exactly
// what this needs. Everything it has to know arrives through the environment,
// set in playwright.config.ts alongside the app servers' own env.
import { startTestIdp } from "./oidc-idp";

const port = Number(process.env.E2E_IDP_PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("E2E_IDP_PORT must be set to the port the test IdP listens on");
}

// The issuer must be the exact URL apps/server reaches this process at: it is
// what discovery advertises and what `jose` checks the id_token's `iss` against.
const issuer = process.env.E2E_IDP_ISSUER;
if (!issuer) {
  throw new Error("E2E_IDP_ISSUER must be set to the URL apps/server reaches the test IdP at");
}

// The single registered callback, matched exactly at /authorize — see oidc-idp.ts.
const redirectUri = process.env.E2E_IDP_REDIRECT_URI;
if (!redirectUri) {
  throw new Error("E2E_IDP_REDIRECT_URI must be set to the app's /api/auth/callback URL");
}

await startTestIdp({ port, issuer, redirectUri });
