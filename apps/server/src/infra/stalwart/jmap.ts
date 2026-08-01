import { DEFAULT_STALWART_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";

export type JmapAuth = { email: string; password: string };
export type JmapSession = {
  apiUrl: string;
  accountId: string;
  eventSourceUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  /**
   * The capability URIs the session advertises (RFC 8620 §2 — the keys of the
   * session's `capabilities` object), i.e. what this server may assume the
   * account's JMAP provider can actually do (GH #36).
   *
   * `getSession` always sets it: `[]` when the provider advertises nothing,
   * which is a real answer ("no extensions") and NOT the same as not knowing.
   * Optional purely so a hand-built session — every JMAP fixture in the test
   * suite — still typechecks and still means "capability unknown"; see
   * modules/sieve/sync.ts's supportsSieve for the one place that distinction
   * is read, and why unknown stays optimistic there.
   */
  capabilities?: string[];
};
export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapMethodResponse = [string, Record<string, unknown>, string];

/**
 * Email properties this server asks for but can live without (GH #144).
 *
 * RFC 8621 §4.2 makes an unrecognised property name a method-level
 * `invalidArguments` error, and a method error fails the whole batch below —
 * so against a provider that does not implement one of these, `GET
 * /threads/:id` returned 502 and NO conversation could be opened at all, while
 * the message list (which never asks for them) went on working. That is a total
 * loss of the reader in exchange for metadata that is optional by construction:
 * every consumer already treats each of these as absent-able
 * (modules/mail/router.ts maps the three threading headers through `?? null`,
 * and sender-auth.ts answers "unknown" for a missing `headers`).
 *
 * So they are declared degradable here, in the one place that can see the
 * method error, rather than each route having to carry a fallback.
 */
export const DEGRADABLE_EMAIL_PROPERTIES = [
  "messageId",
  "references",
  "inReplyTo",
  "headers",
] as const;

const DEGRADABLE_PROPERTY_SET: ReadonlySet<string> = new Set(DEGRADABLE_EMAIL_PROPERTIES);

// Methods that change server state. A retry re-runs every call in the batch, so
// degradation is only ever attempted on a batch that has none of them — reading
// twice is free, creating twice is not.
const MUTATING_METHOD = /\/(set|copy|import)$/;

/** The error type RFC 8620 §3.6.2 / RFC 8621 §4.2 give an unknown property. */
const INVALID_ARGUMENTS = "invalidArguments";

/** The args of the first `["error", …]` in a batch response, or null if none failed. */
function firstMethodError(
  responses: JmapMethodResponse[],
): Record<string, unknown> | null {
  for (const [name, args] of responses) {
    if (name === "error") return args ?? {};
  }
  return null;
}

/**
 * The same calls with every degradable property removed, plus whether anything
 * was actually removed — a batch that asked for none of them has nothing to
 * retry differently, and must fail as it always did.
 */
function withoutDegradableProperties(calls: JmapMethodCall[]): {
  calls: JmapMethodCall[];
  stripped: boolean;
} {
  let stripped = false;
  const reduced = calls.map(([name, args, id]): JmapMethodCall => {
    const properties = args.properties;
    if (!Array.isArray(properties)) return [name, args, id];
    const kept = properties.filter(
      (property) => typeof property !== "string" || !DEGRADABLE_PROPERTY_SET.has(property),
    );
    if (kept.length === properties.length) return [name, args, id];
    stripped = true;
    return [name, { ...args, properties: kept }, id];
  });
  return { calls: reduced, stripped };
}

function basicAuth(auth: JmapAuth): string {
  return `Basic ${btoa(`${auth.email}:${auth.password}`)}`;
}

export function stalwartUnavailable(): DomainError {
  return new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
}

function toDomainError(status: number): DomainError {
  if (status === 401) {
    return new DomainError("mail_auth_failed", 502, "errors.mail_auth_failed");
  }
  return stalwartUnavailable();
}

/**
 * Wraps `fetchFn` so a transport failure — connection refused, reset, DNS
 * error — surfaces as 502 `stalwart_unavailable` rather than propagating raw.
 *
 * A transport failure makes fetch REJECT rather than return a response, so it
 * never reaches the status-based toDomainError mapping. Left alone it reached
 * app.onError and surfaced as a 500 "internal", reporting a known dependency
 * being down as if it were our own bug — and logging it as an unhandled error,
 * burying the real ones (GH #187).
 *
 * Exported because the mapping must not live only inside the JMAP client: the
 * event stream and the blob upload/download routes talk to Stalwart over raw
 * fetch and were still answering 500 for a Stalwart that is simply down
 * (GH #211). One wrapper, one behaviour, wherever this server calls Stalwart.
 *
 * A DomainError already in flight — notably the upstream_timeout (504) that
 * withDeadlineFetch raises (GH #165) — is a correct dependency error with its
 * own status, so it passes through untouched.
 */
export function withStalwartTransportErrors(fetchFn: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await fetchFn(input, init);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw stalwartUnavailable();
    }
  }) as typeof fetch;
}

// Some reverse-proxied Stalwart deployments advertise an internal/unreachable
// origin in the session's apiUrl/uploadUrl/downloadUrl/eventSourceUrl (the
// server's own configured hostname, not the one the client actually reached).
// Rewriting to the connection's origin keeps these servers reachable without
// touching the raw string via the URL API, which percent-encodes the `{...}`
// JMAP placeholders (e.g. `{accountId}`) found in path segments.
function rewriteToConnectionOrigin(url: string, connectionOrigin: string): string {
  return url.replace(/^https?:\/\/[^/]+/i, connectionOrigin);
}

export function createJmapClient(input: {
  baseUrl: string;
  fetchFn?: typeof fetch;
  forceBase?: boolean;
  /** Outbound deadline per JMAP call — see core/deadline.ts (GH #165). */
  timeoutMs?: number;
}) {
  // Every call below goes through the wrapped fetch, so a Stalwart that accepts
  // the connection and never answers surfaces as `upstream_timeout` instead of
  // hanging the request forever.
  const deadlineFetch = withDeadlineFetch(
    input.fetchFn ?? fetch,
    "stalwart",
    input.timeoutMs ?? DEFAULT_STALWART_TIMEOUT_MS,
  );

  // A Stalwart that is down makes fetch reject instead of answering, which
  // would surface as a 500 "internal" without this (GH #187) — see
  // withStalwartTransportErrors above.
  const fetchFn = withStalwartTransportErrors(deadlineFetch);

  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const forceBase = input.forceBase ?? false;

  // Remembered once a provider has refused a degradable property (GH #144), so
  // the double round-trip below is paid once per process rather than on every
  // conversation the user opens. Only ever set, never cleared: a provider does
  // not gain a property mid-session, and the properties it guards are optional,
  // so the worst case of a stale `true` is metadata this server stops asking
  // for until it restarts.
  let degradedProperties = false;

  async function post(
    auth: JmapAuth,
    session: JmapSession,
    calls: JmapMethodCall[],
    extraUsing: string[],
  ): Promise<JmapMethodResponse[]> {
    const res = await fetchFn(session.apiUrl, {
      method: "POST",
      headers: {
        authorization: basicAuth(auth),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        using: [
          "urn:ietf:params:jmap:core",
          "urn:ietf:params:jmap:mail",
          "urn:ietf:params:jmap:submission",
          ...extraUsing,
        ],
        methodCalls: calls,
      }),
    });
    if (!res.ok) throw toDomainError(res.status);
    const body = (await res.json()) as { methodResponses: JmapMethodResponse[] };
    return body.methodResponses ?? [];
  }

  return {
    async getSession(auth: JmapAuth): Promise<JmapSession> {
      const res = await fetchFn(`${baseUrl}/.well-known/jmap`, {
        headers: { authorization: basicAuth(auth), accept: "application/json" },
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as {
        apiUrl?: string;
        eventSourceUrl?: string;
        uploadUrl?: string;
        downloadUrl?: string;
        primaryAccounts?: Record<string, string>;
        capabilities?: Record<string, unknown>;
      };
      const accountId = body.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (!body.apiUrl || !accountId) {
        throw stalwartUnavailable();
      }
      const capabilities = Object.keys(body.capabilities ?? {});
      if (!forceBase) {
        return {
          apiUrl: body.apiUrl,
          accountId,
          eventSourceUrl: body.eventSourceUrl ?? "",
          uploadUrl: body.uploadUrl ?? "",
          downloadUrl: body.downloadUrl ?? "",
          capabilities,
        };
      }
      const connectionOrigin = new URL(baseUrl).origin;
      return {
        apiUrl: rewriteToConnectionOrigin(body.apiUrl, connectionOrigin),
        accountId,
        eventSourceUrl: rewriteToConnectionOrigin(body.eventSourceUrl ?? "", connectionOrigin),
        uploadUrl: rewriteToConnectionOrigin(body.uploadUrl ?? "", connectionOrigin),
        downloadUrl: rewriteToConnectionOrigin(body.downloadUrl ?? "", connectionOrigin),
        capabilities,
      };
    },

    /**
     * Runs a batch, and degrades rather than failing it whole when the only
     * thing the provider objected to is an optional property (GH #144).
     *
     * A method-level error still fails the batch — that is the RFC 8620
     * contract and every caller depends on it. What changed is that ONE
     * specific, recoverable shape of it gets a second chance first: an
     * `invalidArguments` error on a batch that mutates nothing and did ask for
     * a degradable property is retried once without those properties. If the
     * retry succeeds the caller gets a real answer with some metadata missing,
     * which every one of them already handles, instead of a 502.
     */
    async request(
      auth: JmapAuth,
      session: JmapSession,
      calls: JmapMethodCall[],
      extraUsing: string[] = [],
    ): Promise<JmapMethodResponse[]> {
      const first = degradedProperties ? withoutDegradableProperties(calls).calls : calls;
      const responses = await post(auth, session, first, extraUsing);
      const failure = firstMethodError(responses);
      if (!failure) return responses;

      const retryable =
        !degradedProperties &&
        failure.type === INVALID_ARGUMENTS &&
        !calls.some(([name]) => MUTATING_METHOD.test(name));
      if (retryable) {
        const reduced = withoutDegradableProperties(calls);
        if (reduced.stripped) {
          const retried = await post(auth, session, reduced.calls, extraUsing);
          if (!firstMethodError(retried)) {
            degradedProperties = true;
            log("warn", "jmap provider rejected optional email properties, degrading", {
              properties: [...DEGRADABLE_EMAIL_PROPERTIES],
              methods: calls.map(([name]) => name),
            });
            return retried;
          }
        }
      }

      throw new DomainError("jmap_error", 502, "errors.jmap_error");
    },

    async uploadBlob(
      auth: JmapAuth,
      session: JmapSession,
      content: string,
      contentType: string,
    ): Promise<string> {
      const url = session.uploadUrl.replace(
        "{accountId}",
        encodeURIComponent(session.accountId),
      );
      const res = await fetchFn(url, {
        method: "POST",
        headers: { authorization: basicAuth(auth), "content-type": contentType },
        body: content,
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as { blobId?: string };
      if (!body.blobId) {
        throw stalwartUnavailable();
      }
      return body.blobId;
    },
  };
}

export type JmapClient = ReturnType<typeof createJmapClient>;
