import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { DEFAULT_OIDC_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
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

export function oidcUnavailable(): DomainError {
  return new DomainError("oidc_unavailable", 502, "errors.oidc_unavailable");
}

/**
 * Wraps `fetchFn` so a transport failure reaching the identity provider —
 * connection refused, reset, DNS error, TLS failure — surfaces as 502
 * `oidc_unavailable` rather than propagating raw.
 *
 * The twin of withJmapTransportErrors (infra/jmap/client.ts), for the same
 * defect on the other dependency (GH #236, after #187 and #211 fixed it for
 * Stalwart). Both files only ever mapped `!res.ok` to a 502, and a transport
 * failure never produces a response to inspect: fetch REJECTS, withDeadlineFetch
 * rethrows anything that is not its own deadline (core/deadline.ts), and the
 * `TypeError` sailed past every mapping into app.onError. An IdP that is simply
 * down came back as 500 `internal` — this server blaming itself for a third
 * party — and was logged as "unhandled error", which is the bucket the real
 * bugs are supposed to be alone in.
 *
 * A DomainError already in flight passes through untouched: the 504
 * `upstream_timeout` that withDeadlineFetch raises (GH #165) is a correct
 * dependency error with its own status, and "the provider accepted the
 * connection then went silent" must not be flattened into "could not reach the
 * provider".
 */
export function withOidcTransportErrors(fetchFn: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await fetchFn(input, init);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw oidcUnavailable();
    }
  }) as typeof fetch;
}

/**
 * `url` uses `https:`, or `allowInsecureIssuer` is set (GH #347).
 *
 * Guards the issuer itself and every endpoint discovery hands back
 * (`token_endpoint`, `jwks_uri`, `authorization_endpoint`): all of them are
 * used verbatim, including sending the client_secret to `token_endpoint`
 * (auth/router.ts exchangeCode), so an http URL anywhere in that set lets
 * whoever controls the network path impersonate the IdP or read the secret.
 * A malformed URL fails the same way an insecure one does — there is nothing
 * safe to do with either.
 */
function requireHttps(url: string, allowInsecureIssuer: boolean): boolean {
  if (allowInsecureIssuer) return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function discover(
  issuer: string,
  fetchFn: typeof fetch = fetch,
  /** Outbound deadline — see core/deadline.ts (GH #165). */
  timeoutMs: number = DEFAULT_OIDC_TIMEOUT_MS,
  /**
   * Skip the https: requirement on the issuer and every endpoint discovery
   * returns (GH #347). OFF by default. The one legitimate use is a local IdP
   * double that cannot terminate TLS — e2e/oidc-idp.ts, served over plain
   * HTTP on 127.0.0.1/localhost. This is a caller-supplied flag rather than a
   * NODE_ENV check because the e2e suite deliberately boots its app servers
   * with NODE_ENV=production (playwright.config.ts, core/config.ts's
   * WEAK_MASTER_KEY_ENVS) to exercise the same config a real production boot
   * enforces — a NODE_ENV-keyed escape hatch would have to loosen THAT too.
   * See OIDC_ALLOW_INSECURE_ISSUER in core/config.ts.
   */
  allowInsecureIssuer = false,
): Promise<OidcEndpoints> {
  // Refused before any outbound call: an insecure issuer must not even get to
  // amplify into a fetch against whatever it names.
  if (!requireHttps(issuer, allowInsecureIssuer)) {
    throw new DomainError("oidc_discovery_invalid", 502, "errors.oidc_discovery_invalid");
  }
  const wellKnown = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  // Deadline first, transport mapping outermost: the deadline's DomainError has
  // to reach the wrapper as a DomainError so it passes through as 504 instead of
  // being relabelled `oidc_unavailable`.
  const res = await withOidcTransportErrors(withDeadlineFetch(fetchFn, "oidc", timeoutMs))(
    wellKnown,
  );
  if (!res.ok) {
    throw new DomainError("oidc_discovery_failed", 502, "errors.oidc_discovery_failed");
  }
  const doc = (await res.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  };
  // OIDC Discovery §4.3: "The issuer value returned MUST be identical to the
  // Issuer URL that was directly used to retrieve the configuration
  // information" — case-sensitive, trailing slash and all. A mismatch means
  // this document did not come from the issuer that was configured, which is
  // exactly what a malicious or misconfigured discovery response looks like.
  if (doc.issuer !== issuer) {
    throw new DomainError("oidc_issuer_mismatch", 502, "errors.oidc_issuer_mismatch");
  }
  if (
    !requireHttps(doc.authorization_endpoint, allowInsecureIssuer) ||
    !requireHttps(doc.token_endpoint, allowInsecureIssuer) ||
    !requireHttps(doc.jwks_uri, allowInsecureIssuer)
  ) {
    throw new DomainError("oidc_discovery_invalid", 502, "errors.oidc_discovery_invalid");
  }
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
  /** Outbound deadline — see core/deadline.ts (GH #165). */
  timeoutMs?: number;
}): Promise<{ idToken: string }> {
  // Same layering as discover above: an unreachable token endpoint is 502
  // `oidc_unavailable`, a silent one stays 504 `upstream_timeout`.
  const fetchFn = withOidcTransportErrors(
    withDeadlineFetch(
      input.fetchFn ?? fetch,
      "oidc",
      input.timeoutMs ?? DEFAULT_OIDC_TIMEOUT_MS,
    ),
  );
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
    if (payload.email_verified !== true) {
      throw new DomainError(
        "oidc_email_unverified",
        403,
        "errors.oidc_email_unverified",
      );
    }
    return { email: payload.email };
  };
}
