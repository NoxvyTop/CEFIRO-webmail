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

function toDomainError(status: number): DomainError {
  if (status === 401) {
    return new DomainError("mail_auth_failed", 502, "errors.mail_auth_failed");
  }
  return new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
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
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");

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
        throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
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
        throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
      }
      return body.blobId;
    },
  };
}

export type JmapClient = ReturnType<typeof createJmapClient>;
