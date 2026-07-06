import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { DomainError } from "../../core/errors";

export type OidcEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function discover(
  issuer: string,
  fetchFn: typeof fetch = fetch,
): Promise<OidcEndpoints> {
  const wellKnown = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetchFn(wellKnown);
  if (!res.ok) {
    throw new DomainError("oidc_discovery_failed", 502, "errors.oidc_discovery_failed");
  }
  const doc = (await res.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  };
  return {
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    jwksUri: doc.jwks_uri,
  };
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", input.scopes);
  return url.toString();
}

export async function exchangeCode(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
  fetchFn?: typeof fetch;
}): Promise<{ idToken: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const res = await fetchFn(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.verifier,
    }),
  });
  if (!res.ok) {
    throw new DomainError("oidc_exchange_failed", 502, "errors.oidc_exchange_failed");
  }
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) {
    throw new DomainError("oidc_exchange_failed", 502, "errors.oidc_exchange_failed");
  }
  return { idToken: body.id_token };
}

export function remoteKeySource(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri));
}

export function createIdTokenVerifier(input: {
  issuer: string;
  clientId: string;
  keySource: JWTVerifyGetKey;
}): (idToken: string) => Promise<{ email: string }> {
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, input.keySource, {
      issuer: input.issuer,
      audience: input.clientId,
    });
    if (typeof payload.email !== "string" || payload.email.length === 0) {
      throw new DomainError("oidc_email_missing", 502, "errors.oidc_email_missing");
    }
    return { email: payload.email };
  };
}
