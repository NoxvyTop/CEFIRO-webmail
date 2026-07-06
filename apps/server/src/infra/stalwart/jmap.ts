import { DomainError } from "../../core/errors";

export type JmapAuth = { email: string; password: string };
export type JmapSession = {
  apiUrl: string;
  accountId: string;
  eventSourceUrl: string;
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
        primaryAccounts?: Record<string, string>;
      };
      const accountId = body.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (!body.apiUrl || !accountId) {
        throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
      }
      return {
        apiUrl: body.apiUrl,
        accountId,
        eventSourceUrl: body.eventSourceUrl ?? "",
      };
    },

    async request(
      auth: JmapAuth,
      session: JmapSession,
      calls: JmapMethodCall[],
    ): Promise<JmapMethodResponse[]> {
      const res = await fetchFn(session.apiUrl, {
        method: "POST",
        headers: {
          authorization: basicAuth(auth),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
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
  };
}

export type JmapClient = ReturnType<typeof createJmapClient>;
