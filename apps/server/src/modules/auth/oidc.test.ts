import { describe, expect, it } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  buildAuthUrl,
  createIdTokenVerifier,
  createPkce,
  discover,
  exchangeCode,
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
      (await verify(await sign("webmail", { email: "e@noxvytop.com" }))).email,
    ).toBe("e@noxvytop.com");
    await expect(verify(await sign("other-app", { email: "e@x.com" }))).rejects.toThrow();
    await expect(verify(await sign("webmail", {}))).rejects.toMatchObject({
      code: "oidc_email_missing",
    });
  });
});
