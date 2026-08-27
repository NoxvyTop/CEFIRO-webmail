import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { DEFAULT_OIDC_TIMEOUT_MS } from "../../core/deadline";
import { DomainError } from "../../core/errors";
import {
  buildAuthUrl,
  createIdTokenVerifier,
  createPkce,
  discover,
  exchangeCode,
  withOidcTransportErrors,
} from "./oidc";

describe("pkce", () => {
  it("generates a S256 challenge matching the verifier", async () => {
    const { verifier, challenge } = await createPkce();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(challenge).toBe(expected);
  });
});

describe("buildAuthUrl", () => {
  it("includes all oauth params", () => {
    const url = new URL(
      buildAuthUrl({
        authorizationEndpoint: "https://auth.test/authorize",
        clientId: "webmail",
        redirectUri: "http://localhost:5173/api/auth/callback",
        state: "st-1",
        challenge: "ch-1",
        scopes: "openid email",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("webmail");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("code_challenge")).toBe("ch-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email");
  });
});

describe("discover", () => {
  it("maps the well-known document", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: "https://auth.test/authorize",
          token_endpoint: "https://auth.test/token",
          jwks_uri: "https://auth.test/jwks",
        }),
      )) as unknown as typeof fetch;
    const endpoints = await discover("https://auth.test", fetchFn);
    expect(endpoints.tokenEndpoint).toBe("https://auth.test/token");
  });
});

describe("exchangeCode", () => {
  const base = {
    tokenEndpoint: "https://auth.test/token",
    clientId: "webmail",
    clientSecret: "s",
    code: "c",
    redirectUri: "http://localhost:5173/api/auth/callback",
    verifier: "v",
  };

  it("returns the id token on success", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ id_token: "the-token" }))) as unknown as typeof fetch;
    expect((await exchangeCode({ ...base, fetchFn })).idToken).toBe("the-token");
  });

  it("throws a domain error on non-ok response", async () => {
    const fetchFn = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode({ ...base, fetchFn })).rejects.toMatchObject({
      code: "oidc_exchange_failed",
    });
  });
});

// GH #236: an identity provider that is DOWN makes fetch reject with a
// TypeError instead of answering, so it never reached the `!res.ok` mapping
// these two functions had — it sailed into app.onError and came back as a 500
// `internal`, this server taking the blame for a third party being unreachable.
// Every test here drives a REJECTING fetch; a `!ok` response is a different
// failure and is covered above.
describe("unreachable identity provider (GH #236)", () => {
  /** What fetch does when the connection cannot be made at all. */
  function refusedFetch(): typeof fetch {
    return (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
  }

  const exchangeBase = {
    tokenEndpoint: "https://auth.test/token",
    clientId: "webmail",
    clientSecret: "s",
    code: "c",
    redirectUri: "http://localhost:5173/api/auth/callback",
    verifier: "v",
  };

  it("maps a refused discovery to 502 oidc_unavailable, not an internal error", async () => {
    await expect(discover("https://auth.test", refusedFetch())).rejects.toMatchObject({
      code: "oidc_unavailable",
      httpStatus: 502,
    });
  });

  it("maps a refused token exchange to 502 oidc_unavailable", async () => {
    await expect(
      exchangeCode({ ...exchangeBase, fetchFn: refusedFetch() }),
    ).rejects.toMatchObject({ code: "oidc_unavailable", httpStatus: 502 });
  });

  it("leaves a DomainError already in flight alone", async () => {
    // The 504 upstream_timeout withDeadlineFetch raises is a correct, more
    // precise dependency error: "went silent" must not become "unreachable".
    const timedOut = withOidcTransportErrors((async () => {
      throw new DomainError("upstream_timeout", 504, "errors.upstream_timeout");
    }) as unknown as typeof fetch);
    await expect(timedOut("https://auth.test")).rejects.toMatchObject({
      code: "upstream_timeout",
      httpStatus: 504,
    });
  });

  it("passes a successful response straight through", async () => {
    const ok = withOidcTransportErrors((async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch);
    expect((await ok("https://auth.test")).status).toBe(200);
  });
});

describe("outbound deadline (GH #165)", () => {
  /** The identity provider accepts the connection and then never answers. */
  function silentFetch(): typeof fetch {
    return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails discovery with upstream_timeout, not oidc_discovery_failed", async () => {
    vi.useFakeTimers();

    const pending = discover("https://auth.test", silentFetch());
    const assertion = expect(pending).rejects.toMatchObject({
      code: "upstream_timeout",
      httpStatus: 504,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_OIDC_TIMEOUT_MS);
    await assertion;
  });

  it("fails the token exchange with upstream_timeout when the provider never answers", async () => {
    vi.useFakeTimers();

    const pending = exchangeCode({
      tokenEndpoint: "https://auth.test/token",
      clientId: "webmail",
      clientSecret: "s",
      code: "c",
      redirectUri: "http://localhost:5173/api/auth/callback",
      verifier: "v",
      fetchFn: silentFetch(),
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(DEFAULT_OIDC_TIMEOUT_MS);
    await assertion;
  });

  it("honours a configured timeoutMs on discovery", async () => {
    vi.useFakeTimers();

    const pending = discover("https://auth.test", silentFetch(), 3_000);
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).not.toHaveBeenCalled();

    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("honours a configured timeoutMs on the token exchange", async () => {
    vi.useFakeTimers();

    const pending = exchangeCode({
      tokenEndpoint: "https://auth.test/token",
      clientId: "webmail",
      clientSecret: "s",
      code: "c",
      redirectUri: "http://localhost:5173/api/auth/callback",
      verifier: "v",
      fetchFn: silentFetch(),
      timeoutMs: 3_000,
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });
});

describe("id token verification", () => {
  it("verifies a signed token and extracts email; rejects bad audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.alg = "RS256";
    const keySource = createLocalJWKSet({ keys: [jwk] });

    const sign = (audience: string, claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://auth.test")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    const verify = createIdTokenVerifier({
      issuer: "https://auth.test",
      clientId: "webmail",
      keySource,
    });

    expect(
      (await verify(await sign("webmail", { email: "e@noxvytop.com", email_verified: true }))).email,
    ).toBe("e@noxvytop.com");
    await expect(verify(await sign("other-app", { email: "e@x.com", email_verified: true }))).rejects.toThrow();
    await expect(verify(await sign("webmail", { email_verified: true }))).rejects.toMatchObject({
      code: "oidc_email_missing",
    });
    await expect(
      verify(await sign("webmail", { email: "e@noxvytop.com" })),
    ).rejects.toMatchObject({ code: "oidc_email_unverified" });
    await expect(
      verify(await sign("webmail", { email: "e@noxvytop.com", email_verified: false })),
    ).rejects.toMatchObject({ code: "oidc_email_unverified" });
  });
});
