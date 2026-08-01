import { expect, test } from "bun:test";
import {
  IDP_EMAIL_LABEL,
  IDP_HEADING,
  IDP_SUBMIT_LABEL,
  TEST_IDP_CLIENT_ID,
  TEST_IDP_CLIENT_SECRET,
  TEST_IDP_SCOPES,
  startTestIdp,
} from "./oidc-idp";

// GH #247. tests/oidc-login.spec.ts is the only end-to-end cover the production
// login path has, and every assertion it makes is only as good as this provider.
// A double that accepted any client secret, ignored the PKCE binding or reused
// an authorization code would let a genuinely broken server walk through the
// spec and out the other side, green. Nothing in the Playwright suite can
// notice that — the provider is the oracle, and an oracle checks nothing about
// itself.
//
// So the checks whose ABSENCE would be invisible are pinned here: the client
// credentials, the exact-match redirect_uri, the S256 code_challenge binding,
// single-use codes, and a signature that is real rather than asserted. Driven
// over HTTP against a provider started per test, which is also the only way to
// exercise Bun.serve's routing.

const REDIRECT_URI = "http://127.0.0.1:8199/api/auth/callback";
const VERIFIER = "e2e-code-verifier-with-enough-entropy-0123456789";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The S256 challenge for `verifier`, computed the way RFC 7636 defines it. */
async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * Starts a provider on a free ephemeral port.
 *
 * The port cannot be left to the OS (`port: 0`): the issuer has to be known
 * BEFORE the listener exists, because it is baked into the discovery document
 * and into every `iss` claim. So a candidate is picked and retried on collision,
 * which is what `Bun.serve` throwing on EADDRINUSE makes reliable.
 */
async function startProvider(): Promise<{ issuer: string; stop(): void }> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = 21_000 + Math.floor(Math.random() * 20_000);
    const issuer = `http://127.0.0.1:${port}`;
    try {
      const server = await startTestIdp({ port, issuer, redirectUri: REDIRECT_URI });
      return { issuer, stop: () => server.stop(true) };
    } catch {
      // Port taken by something else on this machine; try another.
    }
  }
  throw new Error("could not bind the test identity provider to any candidate port");
}

/** Runs `body` against a fresh provider and always closes its listener. */
async function withProvider<T>(body: (issuer: string) => Promise<T>): Promise<T> {
  const provider = await startProvider();
  try {
    return await body(provider.issuer);
  } finally {
    provider.stop();
  }
}

function authorizeUrl(issuer: string, overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: TEST_IDP_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: "placeholder",
    state: "state-123",
    scope: TEST_IDP_SCOPES,
    ...overrides,
  });
  return `${issuer}/authorize?${params.toString()}`;
}

/** Drives /authorize through to an authorization code, as a browser would. */
async function authorizeToCode(
  issuer: string,
  options: { challenge: string; email?: string; verified?: boolean },
): Promise<{ code: string; state: string }> {
  const page = await fetch(authorizeUrl(issuer, { code_challenge: options.challenge }));
  const html = await page.text();
  const requestId = html.match(/name="request" value="([^"]+)"/)?.[1];
  if (!requestId) throw new Error("the login page did not carry a request id");

  const form = new URLSearchParams({
    request: requestId,
    email: options.email ?? "carlos@cefiro.test",
  });
  if (options.verified !== false) form.set("verified", "yes");

  const submitted = await fetch(`${issuer}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  expect(submitted.status).toBe(303);
  const target = new URL(submitted.headers.get("location") ?? "");
  const code = target.searchParams.get("code");
  const state = target.searchParams.get("state");
  if (!code || !state) throw new Error("the provider redirected without a code and state");
  return { code, state };
}

function tokenBody(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: TEST_IDP_CLIENT_ID,
      client_secret: TEST_IDP_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      ...fields,
    }).toString(),
  };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("discovery advertises endpoints derived from the issuer it was given", async () => {
  await withProvider(async (issuer) => {
    const doc = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
    // apps/server's auth/oidc.ts follows these verbatim; an endpoint pointing
    // anywhere but this listener makes every OIDC assertion untestable.
    expect(doc.issuer).toBe(issuer);
    expect(doc.authorization_endpoint).toBe(`${issuer}/authorize`);
    expect(doc.token_endpoint).toBe(`${issuer}/token`);
    expect(doc.jwks_uri).toBe(`${issuer}/jwks`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(doc.scopes_supported).toEqual(TEST_IDP_SCOPES.split(" "));
  });
});

test("the JWKS publishes exactly one RS256 signing key and no private material", async () => {
  await withProvider(async (issuer) => {
    const { keys } = await (await fetch(`${issuer}/jwks`)).json();
    expect(keys).toHaveLength(1);
    expect(keys[0].alg).toBe("RS256");
    expect(keys[0].use).toBe("sig");
    expect(keys[0].kid).toBeString();
    // The private exponent must never leave the process; exportKey("jwk") on a
    // private key would have emitted `d`, and publishing it would make every
    // signature assertion meaningless.
    expect(keys[0].d).toBeUndefined();
  });
});

test("authorize refuses a client, redirect_uri or PKCE method it does not recognize", async () => {
  await withProvider(async (issuer) => {
    // Each of these is a check whose absence would let a server misconfigured in
    // exactly that way pass tests/oidc-login.spec.ts.
    const cases: [Record<string, string>, RegExp][] = [
      [{ client_id: "otro-cliente" }, /unknown client_id/],
      [{ redirect_uri: "http://evil.test/callback" }, /redirect_uri must be exactly/],
      [{ code_challenge_method: "plain" }, /code_challenge_method must be S256/],
      [{ response_type: "token" }, /unsupported response_type/],
      [{ state: "" }, /code_challenge and state are required/],
    ];
    for (const [overrides, expected] of cases) {
      const response = await fetch(authorizeUrl(issuer, overrides));
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(expected);
    }
  });
});

test("authorize renders a login form the spec can drive by accessible name", async () => {
  await withProvider(async (issuer) => {
    const html = await (await fetch(authorizeUrl(issuer))).text();
    // The spec locates these by the exported strings; rendering anything else
    // breaks the login flow with a locator error instead of a real failure.
    for (const label of [IDP_HEADING, IDP_EMAIL_LABEL, IDP_SUBMIT_LABEL]) {
      expect(html).toContain(label);
    }
  });
});

test("a full authorization mints an id_token whose signature verifies against the JWKS", async () => {
  await withProvider(async (issuer) => {
    const challenge = await challengeOf(VERIFIER);
    const { code, state } = await authorizeToCode(issuer, { challenge });
    // The state has to survive the round trip untouched — apps/server matches it
    // against its own sealed value and aborts the login if it differs.
    expect(state).toBe("state-123");

    const token = await (await fetch(`${issuer}/token`, tokenBody({ code }))).json();
    expect(token.token_type).toBe("Bearer");

    const [rawHeader, rawClaims, rawSignature] = String(token.id_token).split(".");
    const header = decodeJwtPart(rawHeader ?? "");
    const claims = decodeJwtPart(rawClaims ?? "");
    expect(header.alg).toBe("RS256");
    expect(claims.iss).toBe(issuer);
    expect(claims.aud).toBe(TEST_IDP_CLIENT_ID);
    expect(claims.email).toBe("carlos@cefiro.test");
    expect(claims.email_verified).toBe(true);
    expect(Number(claims.exp)).toBeGreaterThan(Number(claims.iat));

    // Verified for real against the published key. The provider signs with raw
    // WebCrypto precisely so a signature is proof rather than a library
    // round-tripping with itself; asserting the claims without this would leave
    // an unsigned token indistinguishable from a signed one.
    const { keys } = await (await fetch(`${issuer}/jwks`)).json();
    expect(header.kid).toBe(keys[0].kid);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      keys[0],
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signed = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(rawSignature ?? "", "base64url"),
      new TextEncoder().encode(`${rawHeader}.${rawClaims}`),
    );
    expect(signed).toBe(true);
  });
});

test("an unchecked verification box produces email_verified false", async () => {
  await withProvider(async (issuer) => {
    const challenge = await challengeOf(VERIFIER);
    const { code } = await authorizeToCode(issuer, { challenge, verified: false });
    const token = await (await fetch(`${issuer}/token`, tokenBody({ code }))).json();
    // apps/server's createIdTokenVerifier must refuse this identity; the refusal
    // is only testable because the provider can be asked to assert it.
    expect(decodeJwtPart(String(token.id_token).split(".")[1] ?? "").email_verified).toBe(false);
  });
});

test("the token endpoint rejects a wrong client secret", async () => {
  await withProvider(async (issuer) => {
    const challenge = await challengeOf(VERIFIER);
    const { code } = await authorizeToCode(issuer, { challenge });
    const response = await fetch(
      `${issuer}/token`,
      tokenBody({ code, client_secret: "not-the-secret" }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("invalid_client");
  });
});

test("the token endpoint rejects a code_verifier that does not match the challenge", async () => {
  await withProvider(async (issuer) => {
    // The challenge was minted from a DIFFERENT verifier, so the S256 binding
    // must fail — this is the check that makes a regression in how apps/server
    // seals and carries its PKCE verifier visible instead of silent.
    const challenge = await challengeOf("some-other-verifier-entirely-0123456789");
    const { code } = await authorizeToCode(issuer, { challenge });
    const response = await fetch(`${issuer}/token`, tokenBody({ code }));
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(/PKCE verification failed/);
  });
});

test("the token endpoint rejects a redirect_uri that differs from the authorized one", async () => {
  await withProvider(async (issuer) => {
    const challenge = await challengeOf(VERIFIER);
    const { code } = await authorizeToCode(issuer, { challenge });
    const response = await fetch(
      `${issuer}/token`,
      tokenBody({ code, redirect_uri: "http://evil.test/callback" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(/redirect_uri mismatch/);
  });
});

test("an authorization code is single use", async () => {
  await withProvider(async (issuer) => {
    const challenge = await challengeOf(VERIFIER);
    const { code } = await authorizeToCode(issuer, { challenge });
    expect((await fetch(`${issuer}/token`, tokenBody({ code }))).status).toBe(200);
    // A replayed code is as dead as an unknown one, exactly as at a real
    // provider — otherwise a leaked code in a trace would still be usable.
    const replay = await fetch(`${issuer}/token`, tokenBody({ code }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });
});

test("an authorization request cannot be completed twice", async () => {
  await withProvider(async (issuer) => {
    const html = await (await fetch(authorizeUrl(issuer))).text();
    const requestId = html.match(/name="request" value="([^"]+)"/)?.[1] ?? "";
    const submit = () =>
      fetch(`${issuer}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request: requestId, email: "carlos@cefiro.test" }).toString(),
        redirect: "manual",
      });
    expect((await submit()).status).toBe(303);
    const second = await submit();
    expect(second.status).toBe(400);
    expect(await second.text()).toMatch(/unknown or already-completed authorization request/);
  });
});

test("the token endpoint refuses a grant type it does not implement", async () => {
  await withProvider(async (issuer) => {
    const response = await fetch(
      `${issuer}/token`,
      tokenBody({ code: "irrelevant", grant_type: "client_credentials" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("unsupported_grant_type");
  });
});

test("anything outside the four published endpoints is a 404", async () => {
  await withProvider(async (issuer) => {
    expect((await fetch(`${issuer}/userinfo`)).status).toBe(404);
    // Right path, wrong method: /token is POST-only.
    expect((await fetch(`${issuer}/token`)).status).toBe(404);
  });
});
