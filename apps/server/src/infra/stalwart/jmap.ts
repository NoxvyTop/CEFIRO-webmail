import { DEFAULT_STALWART_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import { DomainError } from "../../core/errors";

export type JmapAuth = { email: string; password: string };
export type JmapSession = {
  apiUrl: string;
  accountId: string;
  eventSourceUrl: string;
  uploadUrl: string;
  downloadUrl: string;
};
export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapMethodResponse = [string, Record<string, unknown>, string];

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
      };
      const accountId = body.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (!body.apiUrl || !accountId) {
        throw stalwartUnavailable();
      }
      if (!forceBase) {
        return {
          apiUrl: body.apiUrl,
          accountId,
          eventSourceUrl: body.eventSourceUrl ?? "",
          uploadUrl: body.uploadUrl ?? "",
          downloadUrl: body.downloadUrl ?? "",
        };
      }
      const connectionOrigin = new URL(baseUrl).origin;
      return {
        apiUrl: rewriteToConnectionOrigin(body.apiUrl, connectionOrigin),
        accountId,
        eventSourceUrl: rewriteToConnectionOrigin(body.eventSourceUrl ?? "", connectionOrigin),
        uploadUrl: rewriteToConnectionOrigin(body.uploadUrl ?? "", connectionOrigin),
        downloadUrl: rewriteToConnectionOrigin(body.downloadUrl ?? "", connectionOrigin),
      };
    },

    async request(
      auth: JmapAuth,
      session: JmapSession,
      calls: JmapMethodCall[],
      extraUsing: string[] = [],
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
      for (const [name] of body.methodResponses) {
        if (name === "error") {
          throw new DomainError("jmap_error", 502, "errors.jmap_error");
        }
      }
      return body.methodResponses;
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
