import { DEFAULT_JMAP_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";

export type JmapAuth = { email: string; password: string };

/**
 * What this server does with the URLs the JMAP provider advertises in its
 * session — `apiUrl`, `uploadUrl`, `downloadUrl`, `eventSourceUrl` (GH #34,
 * design GH #188).
 *
 * - `rewrite` (default): replace the ORIGIN of each advertised URL with the
 *   origin of the configured `JMAP_URL`, keeping path, query and the
 *   `{accountId}`-style JMAP placeholders intact. Correct in every deployment
 *   where the provider sits behind a proxy or answers on a name this process
 *   does not use to reach it, which is nearly all of them.
 * - `trust`: use the advertised URLs verbatim. For the rare split-host
 *   provider whose blobs/downloads genuinely live on another reachable origin.
 *
 * `rewrite` is the default deliberately (GH #188): trusting the advertisement
 * was the old default and was the single largest source of "discovery works,
 * every subsequent call 502s" misconfigurations. No `auto` mode exists — a
 * probe-and-guess third mode was considered and rejected as magic.
 */
export type JmapUrlMode = "rewrite" | "trust";

/**
 * How the mailbox credential is presented to the JMAP provider (GH #35).
 *
 * - `basic` (default): HTTP Basic with `email:password`, what Stalwart and
 *   most self-hosted providers expect.
 * - `bearer`: `Authorization: Bearer <credential>`, what token/OAuth providers
 *   (Fastmail and friends) expect. The stored, encrypted mailbox credential IS
 *   the token; nothing else about the two-password model changes — the webmail
 *   session password and the mailbox credential stay separate.
 */
export type JmapAuthMode = "basic" | "bearer";

/** The advertised URL fields of a JMAP session that carry an origin. */
export type JmapSessionUrls = {
  apiUrl: string;
  eventSourceUrl: string;
  uploadUrl: string;
  downloadUrl: string;
};
/**
 * One account reachable in a JMAP session (RFC 8620 §2 `accounts`) — GH #13/#50
 * shared mailboxes. `id` is the JMAP accountId; `name` its display name;
 * `isPersonal` marks the member's OWN mail account (the one `accountId` points
 * at). A group/shared account Stalwart exposes via membership is `isPersonal:
 * false`, and is what the member can browse by passing its id as `?accountId=`.
 */
export type JmapAccount = { id: string; name: string; isPersonal: boolean };

export type JmapSession = {
  apiUrl: string;
  accountId: string;
  eventSourceUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  /**
   * Every account this credential can reach in the session, personal and shared
   * alike (GH #13/#50). `getSession` builds it from the session's `accounts`
   * object and always sets it; back-compat keeps `accountId` pointing at the
   * personal account.
   *
   * Optional for the same reason `capabilities` is: a hand-built session — every
   * JMAP fixture in the test suite — still typechecks and means "accounts
   * unknown", which resolveAccountId treats as "only the personal account is
   * known".
   */
  accounts?: JmapAccount[];
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

/**
 * The `Authorization` header value for one mailbox credential (GH #35).
 *
 * Exported because the JMAP client is not the only caller: the SSE stream and
 * the blob upload/download routes talk to the provider over raw fetch
 * (modules/mail/router.ts) and must present the credential the same way, or
 * `bearer` would work for the API and silently 401 for attachments.
 */
export function jmapAuthHeader(auth: JmapAuth, mode: JmapAuthMode = "basic"): string {
  if (mode === "bearer") return `Bearer ${auth.password}`;
  return `Basic ${btoa(`${auth.email}:${auth.password}`)}`;
}

/**
 * The 502 for "the mail provider is not answering, or answered with garbage".
 *
 * The CODE deliberately keeps its original `stalwart_unavailable` spelling
 * while the function around it moved to role-based naming (GH #33): the string
 * is a wire contract — the SPA maps it in apps/web/src/app/errorMessages.ts,
 * `errors.stalwart_unavailable` is an i18n key, and docs/OPERATIONS.md tells
 * operators to grep for it. Renaming names in code is free; renaming a
 * published error code is a breaking API change for no portability gain.
 */
export function jmapUnavailable(): DomainError {
  return new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
}

function toDomainError(status: number): DomainError {
  if (status === 401) {
    return new DomainError("mail_auth_failed", 502, "errors.mail_auth_failed");
  }
  return jmapUnavailable();
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
 * event stream and the blob upload/download routes talk to the provider over
 * raw fetch and were still answering 500 for a provider that is simply down
 * (GH #211). One wrapper, one behaviour, wherever this server calls JMAP.
 *
 * A DomainError already in flight — notably the upstream_timeout (504) that
 * withDeadlineFetch raises (GH #165) — is a correct dependency error with its
 * own status, so it passes through untouched.
 */
export function withJmapTransportErrors(fetchFn: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await fetchFn(input, init);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw jmapUnavailable();
    }
  }) as typeof fetch;
}

// Rewriting to the connection's origin keeps a provider that advertises an
// unreachable one usable, without touching the raw string via the URL API,
// which percent-encodes the `{...}` JMAP placeholders (e.g. `{accountId}`)
// found in path segments.
function rewriteToConnectionOrigin(url: string, connectionOrigin: string): string {
  return url.replace(/^https?:\/\/[^/]+/i, connectionOrigin);
}

/**
 * Applies `mode` to the four advertised session URLs (GH #34 / GH #188).
 *
 * Pure and exported so the boot probe (infra/jmap/probe.ts) reports the URLs
 * this process will ACTUALLY use, not the ones the provider claimed — an
 * operator reading the startup log needs the resolved pair to see a topology
 * mistake, which was the whole point of the probe.
 *
 * An empty string stays empty: an absent advertisement is not an origin to
 * rewrite, and every consumer already treats "" as "this provider offers no
 * upload/download/event endpoint".
 */
export function resolveSessionUrls(
  advertised: JmapSessionUrls,
  baseUrl: string,
  mode: JmapUrlMode,
): JmapSessionUrls {
  if (mode === "trust") return { ...advertised };
  const origin = new URL(baseUrl).origin;
  const rewrite = (url: string) => (url === "" ? "" : rewriteToConnectionOrigin(url, origin));
  return {
    apiUrl: rewrite(advertised.apiUrl),
    eventSourceUrl: rewrite(advertised.eventSourceUrl),
    uploadUrl: rewrite(advertised.uploadUrl),
    downloadUrl: rewrite(advertised.downloadUrl),
  };
}

/**
 * The JMAP accountId a mail request should run against, given the optional
 * `?accountId=` the client asked for (GH #13/#50 shared mailboxes).
 *
 * - absent (undefined / null / "") → the member's personal account, so every
 *   route behaves exactly as it did before the shared-mailbox work.
 * - present and reachable in this session (the personal account, or a shared
 *   account Stalwart exposes via membership) → that account.
 * - present but NOT reachable → 403 `account_forbidden`.
 *
 * Defense in depth (design GH #13, "Autorización"): Stalwart already lists only
 * the accounts a member may see, so an id outside the session would never have
 * worked upstream anyway — this turns that into a clean, id-non-leaking error
 * instead of an opaque JMAP failure, and keeps a client from probing account
 * ids. An absent `accounts` list (a hand-built session) still admits the
 * personal accountId, so existing single-account callers are unaffected.
 */
export function resolveAccountId(
  session: JmapSession,
  requested: string | null | undefined,
): string {
  if (requested === undefined || requested === null || requested === "") {
    return session.accountId;
  }
  const reachable =
    requested === session.accountId ||
    (session.accounts ?? []).some((account) => account.id === requested);
  if (!reachable) {
    throw new DomainError("account_forbidden", 403, "errors.account_forbidden");
  }
  return requested;
}

export function createJmapClient(input: {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** What to do with the URLs the provider advertises — defaults to `rewrite`. */
  urlMode?: JmapUrlMode;
  /** How to present the mailbox credential — defaults to `basic`. */
  authMode?: JmapAuthMode;
  /** Outbound deadline per JMAP call — see core/deadline.ts (GH #165). */
  timeoutMs?: number;
}) {
  // Every call below goes through the wrapped fetch, so a provider that accepts
  // the connection and never answers surfaces as `upstream_timeout` instead of
  // hanging the request forever.
  //
  // The dependency label stays "stalwart": it is the key of the `/metrics`
  // series (`cefiro_dependency_up`, `cefiro_outbound_requests_total`) and of
  // the `/api/health` check, i.e. something operators' dashboards and alerts
  // are already keyed on. GH #33 renames names in code, not published labels.
  const deadlineFetch = withDeadlineFetch(
    input.fetchFn ?? fetch,
    "stalwart",
    input.timeoutMs ?? DEFAULT_JMAP_TIMEOUT_MS,
  );

  // A provider that is down makes fetch reject instead of answering, which
  // would surface as a 500 "internal" without this (GH #187) — see
  // withJmapTransportErrors above.
  const fetchFn = withJmapTransportErrors(deadlineFetch);

  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const urlMode: JmapUrlMode = input.urlMode ?? "rewrite";
  const authMode: JmapAuthMode = input.authMode ?? "basic";

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
        authorization: jmapAuthHeader(auth, authMode),
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
        headers: { authorization: jmapAuthHeader(auth, authMode), accept: "application/json" },
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as {
        apiUrl?: string;
        eventSourceUrl?: string;
        uploadUrl?: string;
        downloadUrl?: string;
        primaryAccounts?: Record<string, string>;
        accounts?: Record<string, { name?: string; isPersonal?: boolean } | undefined>;
        capabilities?: Record<string, unknown>;
      };
      const accountId = body.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (!body.apiUrl || !accountId) {
        throw jmapUnavailable();
      }
      // GH #13/#50: keep every account the session lists, not just the primary
      // one this server used to take. `isPersonal` is derived from the primary
      // mail account rather than the session's own flag so it is exactly "the
      // member's own mailbox" — the shared/group accounts (isPersonal: false)
      // are what GET /shared-accounts returns and what resolveAccountId admits.
      const accounts: JmapAccount[] = Object.entries(body.accounts ?? {}).map(
        ([id, info]) => ({
          id,
          name: typeof info?.name === "string" ? info.name : "",
          isPersonal: id === accountId,
        }),
      );
      const capabilities = Object.keys(body.capabilities ?? {});
      const urls = resolveSessionUrls(
        {
          apiUrl: body.apiUrl,
          eventSourceUrl: body.eventSourceUrl ?? "",
          uploadUrl: body.uploadUrl ?? "",
          downloadUrl: body.downloadUrl ?? "",
        },
        baseUrl,
        urlMode,
      );
      return { ...urls, accountId, accounts, capabilities };
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
        headers: { authorization: jmapAuthHeader(auth, authMode), "content-type": contentType },
        body: content,
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as { blobId?: string };
      if (!body.blobId) {
        throw jmapUnavailable();
      }
      return body.blobId;
    },
  };
}

export type JmapClient = ReturnType<typeof createJmapClient>;
