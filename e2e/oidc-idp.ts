/**
 * A minimal OpenID Connect provider, used as the identity provider the
 * Playwright suite logs in against — GH #217.
 *
 * Why a purpose-built provider instead of the real one: production talks to
 * Authentik, and bringing Authentik into the e2e stack costs a second Postgres,
 * a Redis, a server, a worker, an initial-setup flow to script, and a fixture
 * that has to be re-provisioned every time its schema moves. What
 * apps/server actually depends on is far smaller — four HTTP endpoints and a
 * signature it can verify:
 *
 *   GET  /.well-known/openid-configuration   discovery      (auth/oidc.ts discover)
 *   GET  /authorize                          the login page (auth/oidc.ts buildAuthUrl)
 *   POST /token                              the code exchange   (auth/oidc.ts exchangeCode)
 *   GET  /jwks                               the signing key (auth/oidc.ts remoteKeySource)
 *
 * Nothing here stubs out the server's own verification, which is the point of
 * the exercise. The id_token is signed with a real RSA key generated at boot and
 * published at /jwks, and `jose` — inside apps/server/src/modules/auth/oidc.ts,
 * untouched — fetches that JWKS and checks the signature, `iss` and `aud` for
 * real. The signing side below is written directly against WebCrypto rather than
 * against `jose`, deliberately: a double that signed with the same library the
 * server verifies with would prove only that the library round-trips with
 * itself.
 *
 * The checks this provider enforces are the ones whose absence would let a
 * broken server pass: the client id and secret, an exact-match redirect_uri, and
 * the S256 PKCE binding between the `code_challenge` sent to /authorize and the
 * `code_verifier` sent to /token. A regression in how the server mints, seals or
 * carries its PKCE verifier fails the exchange here instead of going unnoticed.
 *
 * Runs under Bun (see idp-serve.ts). `Bun.serve` is referenced only inside
 * startTestIdp so that global-setup.ts and the specs — which Playwright executes
 * under Node — can import the constants below without needing a Bun runtime.
 */

/**
 * Carries the provider's issuer URL from playwright.config.ts — which mints it
 * while the config is being built, because Playwright starts `webServer` before
 * globalSetup — to global-setup.ts, which seeds it into the encrypted
 * sso_config row, and to idp-serve.ts, which serves under it.
 */
export const IDP_ISSUER_ENV = "E2E_IDP_ISSUER";

/** The client apps/server authenticates as; seeded into sso_config by global-setup.ts. */
export const TEST_IDP_CLIENT_ID = "cefiro-e2e";

/**
 * Not a secret worth protecting — this provider exists only for the duration of
 * a Playwright run and is torn down with it. It is still verified for real at
 * /token, so a server that sends the wrong one fails the exchange.
 */
export const TEST_IDP_CLIENT_SECRET = "e2e-idp-client-secret";

/** Scopes seeded into sso_config; echoed back in the discovery document. */
export const TEST_IDP_SCOPES = "openid email profile";

/**
 * Accessible names on the /authorize login form. Exported so the spec locates
 * the provider's controls by the same strings this file renders, instead of the
 * two drifting apart silently.
 */
export const IDP_HEADING = "Test identity provider";
export const IDP_EMAIL_LABEL = "Email address";
export const IDP_EMAIL_VERIFIED_LABEL = "Email is verified";
export const IDP_SUBMIT_LABEL = "Sign in";

/**
 * An app-side account seeded deactivated by global-setup.ts.
 *
 * It lives here, next to the rest of the OIDC vocabulary, because it is only
 * ever meaningful as "an identity this provider will happily authenticate that
 * the app must nonetheless refuse" — the archived-user branch of
 * modules/auth/router.ts's callback. Both the seeder and the spec need the exact
 * address, and a copy in each is a silent-drift bug waiting to happen.
 */
export const OIDC_ARCHIVED_EMAIL = "archivado.e2e@cefiro.test";

/** Authorization codes are single-use and short-lived, as at a real provider. */
const CODE_TTL_MS = 60_000;
/** Lifetime stamped on the id_token's `exp`; `jose` enforces it on the server. */
const ID_TOKEN_TTL_S = 300;
/** Published in the JWKS and in every id_token header, so `jose` can match them. */
const KEY_ID = "cefiro-e2e-idp-key";

type PendingAuthorization = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

type AuthorizationCode = PendingAuthorization & {
  email: string;
  emailVerified: boolean;
  expiresAt: number;
};

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The S256 code challenge for `verifier`, as RFC 7636 defines it. */
async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function problem(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/**
 * Signs an id_token as RS256.
 *
 * Hand-assembled rather than delegated to a JWT library on purpose — see this
 * file's header: the server verifies with `jose`, so the double must sign with
 * something else for the test to mean anything.
 */
async function signIdToken(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT", kid: KEY_ID };
  const signingInput =
    `${base64Url(encoder.encode(JSON.stringify(header)))}.` +
    `${base64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * The provider's login page.
 *
 * Only `requestId` is interpolated and it is a UUID this process minted, so no
 * caller-supplied value is ever written into this markup — the authorize
 * parameters stay server-side in `pending` instead of being round-tripped
 * through hidden fields.
 */
function loginPage(requestId: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${IDP_HEADING}</title></head>
  <body>
    <h1>${IDP_HEADING}</h1>
    <form method="post" action="/authorize">
      <input type="hidden" name="request" value="${requestId}">
      <label for="idp-email">${IDP_EMAIL_LABEL}</label>
      <input id="idp-email" name="email" type="email" autocomplete="off" required>
      <label for="idp-verified">${IDP_EMAIL_VERIFIED_LABEL}</label>
      <input id="idp-verified" name="verified" type="checkbox" value="yes" checked>
      <button type="submit">${IDP_SUBMIT_LABEL}</button>
    </form>
  </body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Starts the provider on `port` and resolves once it is listening; the process
 * stays alive on the open listener and Playwright kills it when the run ends
 * (see idp-serve.ts), so there is deliberately no shutdown handle here.
 *
 * `issuer` must be the URL the server reaches this process at, byte for byte:
 * it is both what discovery advertises and the `iss` claim `jose` checks on the
 * server side, and a mismatch is exactly the failure this provider should
 * report rather than paper over. `redirectUri` is the single registered
 * callback — an exact-match check, as a real provider does, so the server's
 * `${APP_URL}/api/auth/callback` is verified rather than assumed.
 */
export async function startTestIdp(options: {
  port: number;
  issuer: string;
  redirectUri: string;
}): Promise<void> {
  const { issuer, redirectUri } = options;
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  // Only the public half, and only the members `jose` needs to select and use
  // the key: exportKey also emits `ext`/`key_ops`, which have no meaning in a
  // published JWKS.
  const publicJwk = {
    kty: exported.kty,
    n: exported.n,
    e: exported.e,
    alg: "RS256",
    use: "sig",
    kid: KEY_ID,
  };

  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, AuthorizationCode>();

  function discoveryDocument(): Response {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: TEST_IDP_SCOPES.split(" "),
    });
  }

  function authorize(url: URL): Response {
    const params = url.searchParams;
    if (params.get("response_type") !== "code") {
      return problem("unsupported response_type");
    }
    if (params.get("client_id") !== TEST_IDP_CLIENT_ID) {
      return problem("unknown client_id");
    }
    if (params.get("redirect_uri") !== redirectUri) {
      return problem(`redirect_uri must be exactly ${redirectUri}`);
    }
    if (params.get("code_challenge_method") !== "S256") {
      return problem("code_challenge_method must be S256");
    }
    const codeChallenge = params.get("code_challenge");
    const state = params.get("state");
    if (!codeChallenge || !state) {
      return problem("code_challenge and state are required");
    }
    const requestId = crypto.randomUUID();
    pending.set(requestId, {
      clientId: TEST_IDP_CLIENT_ID,
      redirectUri,
      state,
      codeChallenge,
    });
    return loginPage(requestId);
  }

  async function completeAuthorization(request: Request): Promise<Response> {
    const form = await request.formData();
    const requestId = String(form.get("request") ?? "");
    const authorization = pending.get(requestId);
    if (!authorization) {
      return problem("unknown or already-completed authorization request");
    }
    pending.delete(requestId);
    const email = String(form.get("email") ?? "").trim();
    if (!email) return problem("email is required");

    // Expired codes are pruned here rather than on a timer, so the provider
    // holds no handles that would keep the process alive past `stop()`.
    const now = Date.now();
    for (const [issued, record] of codes) {
      if (record.expiresAt <= now) codes.delete(issued);
    }

    const code = crypto.randomUUID();
    codes.set(code, {
      ...authorization,
      email,
      // Unchecked box means an unverified address, which the server must refuse
      // (auth/oidc.ts createIdTokenVerifier) — that refusal is a spec of its own.
      emailVerified: form.get("verified") === "yes",
      expiresAt: now + CODE_TTL_MS,
    });

    const target = new URL(authorization.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", authorization.state);
    return new Response(null, { status: 303, headers: { location: target.toString() } });
  }

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") !== "authorization_code") {
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (
      form.get("client_id") !== TEST_IDP_CLIENT_ID ||
      form.get("client_secret") !== TEST_IDP_CLIENT_SECRET
    ) {
      return json({ error: "invalid_client" }, 401);
    }
    const code = form.get("code") ?? "";
    const issued = codes.get(code);
    // Single use: a replayed code is as dead as an unknown one.
    codes.delete(code);
    if (!issued || issued.expiresAt <= Date.now()) {
      return json({ error: "invalid_grant" }, 400);
    }
    if (form.get("redirect_uri") !== issued.redirectUri) {
      return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    const verifier = form.get("code_verifier") ?? "";
    if ((await challengeOf(verifier)) !== issued.codeChallenge) {
      return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }

    const nowS = Math.floor(Date.now() / 1000);
    const idToken = await signIdToken(keyPair.privateKey, {
      iss: issuer,
      aud: issued.clientId,
      sub: `e2e|${issued.email}`,
      iat: nowS,
      exp: nowS + ID_TOKEN_TTL_S,
      email: issued.email,
      email_verified: issued.emailVerified,
      name: issued.email.split("@")[0],
    });
    return json({
      access_token: base64Url(crypto.getRandomValues(new Uint8Array(24))),
      token_type: "Bearer",
      expires_in: ID_TOKEN_TTL_S,
      id_token: idToken,
    });
  }

  Bun.serve({
    port: options.port,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return discoveryDocument();
      }
      if (request.method === "GET" && url.pathname === "/jwks") {
        return json({ keys: [publicJwk] });
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        return authorize(url);
      }
      if (request.method === "POST" && url.pathname === "/authorize") {
        return completeAuthorization(request);
      }
      if (request.method === "POST" && url.pathname === "/token") {
        return token(request);
      }
      return problem("not found", 404);
    },
  });
}
