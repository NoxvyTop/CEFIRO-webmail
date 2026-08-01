import { Hono } from "hono";
import {
  blobUploadResultSchema,
  emailUpdateSchema,
  identitySchema,
  saveDraftResultSchema,
  saveDraftSchema,
  sendEmailSchema,
  signatureInputSchema,
  userPreferencesUpdateSchema,
  type AttachmentMeta,
  type EmailAddress,
  type EmailDetail,
  type EmailSummary,
  type Identity,
  type Mailbox,
  type MessagesPage,
  type ThreadDetail,
} from "@webmail/shared";
import { requireSession } from "../auth/middleware";
import { DEFAULT_STALWART_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import { errorResponse } from "../../core/error-response";
import { clearIdleTimeout } from "../../core/idle-timeout";
import { currentLogContext, log, withLogContext } from "../../core/logger";
import { requireMail, type MailDeps, type MailVariables } from "./context";
import { harvestOnMailArrival } from "./contacts-harvest";
import { tapEmailStateChanges } from "./contacts-harvest-stream";
import { deriveSenderAuthVerdict } from "./sender-auth";
import {
  withStalwartTransportErrors,
  type JmapAuth,
  type JmapClient,
  type JmapMethodCall,
  type JmapSession,
} from "../../infra/stalwart/jmap";

type JmapMailbox = {
  id: string;
  name: string;
  parentId?: string | null;
  role?: string | null;
  sortOrder?: number;
  unreadEmails?: number;
  totalEmails?: number;
};

type JmapEmailAddress = { name?: string | null; email: string };

type JmapEmail = {
  id: string;
  threadId: string;
  mailboxIds?: Record<string, boolean>;
  from?: JmapEmailAddress[];
  to?: JmapEmailAddress[];
  subject?: string | null;
  receivedAt: string;
  preview?: string | null;
  keywords?: Record<string, boolean>;
  hasAttachment?: boolean;
  size?: number;
};

type JmapBodyPart = { partId: string; type?: string | null };
type JmapBodyValue = { value: string };
type JmapAttachment = {
  blobId?: string;
  name?: string | null;
  type?: string | null;
  size?: number;
  // Content-ID (without angle brackets) when this attachment body part is
  // referenced inline from the HTML body via <img src="cid:...">.
  cid?: string | null;
};

// GH #136: the full, ordered header list (RFC 8621 §4.1.1) — requested
// instead of the narrower `header:Authentication-Results:asText` accessor
// because this server can return the WRONG instance from that accessor when
// a message carries more than one header with the same name (e.g. a sender-
// forged one). See sender-auth.ts's file header for the live investigation
// behind this choice.
type JmapHeader = { name: string; value: string };

type JmapEmailDetail = JmapEmail & {
  cc?: JmapEmailAddress[];
  replyTo?: JmapEmailAddress[];
  htmlBody?: JmapBodyPart[];
  textBody?: JmapBodyPart[];
  bodyValues?: Record<string, JmapBodyValue>;
  attachments?: JmapAttachment[];
  // RFC 5322 threading headers (this message's own Message-ID, the
  // Message-IDs of its ancestors, and the Message-ID it replied to) — see
  // EmailDetail.messageId/.references/.inReplyTo in @webmail/shared for how
  // the composer uses these to build a reply's In-Reply-To/References.
  messageId?: string[] | null;
  references?: string[] | null;
  inReplyTo?: string[] | null;
  headers?: JmapHeader[];
};

type JmapThread = { id: string; emailIds: string[] };

type JmapIdentity = {
  id: string;
  name?: string | null;
  email: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type JmapFilter = Record<string, unknown>;

const KEYWORD_PATTERN = /^[A-Za-z0-9$_.-]{1,64}$/;

function recipientMatch(address: string): JmapFilter {
  return { operator: "OR", conditions: [{ to: address }, { cc: address }] };
}

function buildMessagesFilter(input: {
  mailboxId?: string;
  query?: string;
  to?: string;
  excludeTo: string[];
  excludeMailboxId?: string;
  hasKeywords: string[];
}): JmapFilter {
  const conditions: JmapFilter[] = [];
  if (input.mailboxId) conditions.push({ inMailbox: input.mailboxId });
  for (const keyword of input.hasKeywords) conditions.push({ hasKeyword: keyword });
  if (input.query) conditions.push({ text: input.query });
  if (input.to) conditions.push(recipientMatch(input.to));
  if (input.excludeTo.length > 0) {
    conditions.push({ operator: "NOT", conditions: input.excludeTo.map(recipientMatch) });
  }
  if (input.excludeMailboxId) {
    conditions.push({ operator: "NOT", conditions: [{ inMailbox: input.excludeMailboxId }] });
  }
  return conditions.length === 1 ? conditions[0]! : { operator: "AND", conditions };
}

function toEmailAddresses(addresses?: JmapEmailAddress[]): EmailAddress[] {
  return (addresses ?? []).map((a) => ({ name: a.name ?? null, email: a.email }));
}

function toMailboxIds(mailboxIds?: Record<string, boolean>): string[] {
  return Object.entries(mailboxIds ?? {})
    .filter(([, value]) => value)
    .map(([id]) => id);
}

function toEmailSummary(email: JmapEmail): EmailSummary {
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds: toMailboxIds(email.mailboxIds),
    from: toEmailAddresses(email.from),
    to: toEmailAddresses(email.to),
    subject: email.subject ?? "",
    receivedAt: email.receivedAt,
    preview: email.preview ?? "",
    keywords: email.keywords ?? {},
    hasAttachment: email.hasAttachment ?? false,
    size: email.size ?? 0,
  };
}

function concatBodyValues(
  parts: JmapBodyPart[] | undefined,
  bodyValues: Record<string, JmapBodyValue> | undefined,
): string | null {
  const values = (parts ?? [])
    .map((part) => bodyValues?.[part.partId]?.value)
    .filter((value): value is string => value !== undefined);
  return values.length === 0 ? null : values.join("");
}

function toAttachments(attachments?: JmapAttachment[]): AttachmentMeta[] {
  return (attachments ?? [])
    .filter((a): a is JmapAttachment & { blobId: string } => Boolean(a.blobId))
    .map((a) => ({
      blobId: a.blobId,
      name: a.name ?? null,
      type: a.type ?? "application/octet-stream",
      size: a.size ?? 0,
      cid: a.cid ?? null,
    }));
}

function toEmailDetail(email: JmapEmailDetail): EmailDetail {
  return {
    ...toEmailSummary(email),
    cc: toEmailAddresses(email.cc),
    replyTo: toEmailAddresses(email.replyTo),
    bodyHtml: concatBodyValues(email.htmlBody, email.bodyValues),
    bodyText: concatBodyValues(email.textBody, email.bodyValues),
    attachments: toAttachments(email.attachments),
    messageId: email.messageId ?? null,
    references: email.references ?? null,
    inReplyTo: email.inReplyTo ?? null,
    senderAuth: deriveSenderAuthVerdict(email.headers),
  };
}

function basicAuthHeader(auth: { email: string; password: string }): string {
  return `Basic ${btoa(`${auth.email}:${auth.password}`)}`;
}

// Content-types that are safe to render inline in the browser: no active script
// execution vectors (e.g. no text/html, image/svg+xml, xml, octet-stream).
const SAFE_INLINE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

function baseMimeType(contentType: string): string {
  const semicolonIndex = contentType.indexOf(";");
  const raw = semicolonIndex === -1 ? contentType : contentType.slice(0, semicolonIndex);
  return raw.trim().toLowerCase();
}

// Shared by /send and /drafts (GH #149): both need the sending identity
// resolved and the account's mailbox roles before they can build the
// Email/set create object below. Each caller picks whichever roles it needs
// (drafts always; sent/trash depending on the route) out of the returned
// list — resolving all roles here keeps this lookup reusable instead of
// baking a specific role requirement into it.
async function lookupComposeContext(
  jmap: JmapClient,
  auth: JmapAuth,
  session: JmapSession,
  identityId: string,
): Promise<{ identity: JmapIdentity; mailboxes: JmapMailbox[] } | null> {
  const lookup = await jmap.request(auth, session, [
    ["Identity/get", { accountId: session.accountId, ids: [identityId] }, "i"],
    ["Mailbox/get", { accountId: session.accountId, properties: ["id", "role"] }, "m"],
  ]);

  const identityResult = (lookup[0]?.[1] ?? {}) as { list?: JmapIdentity[] };
  const identity = (identityResult.list ?? [])[0];
  if (!identity) return null;

  const mailboxResult = (lookup[1]?.[1] ?? {}) as { list?: JmapMailbox[] };
  return { identity, mailboxes: mailboxResult.list ?? [] };
}

type ComposeAttachment = { blobId: string; name: string; type: string };

type ComposeEmailInput = {
  identity: JmapIdentity;
  draftsMailboxId: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments: ComposeAttachment[];
  inReplyTo?: string[];
  references?: string[];
  keywords: Record<string, boolean>;
};

// Shared by /send and /drafts (GH #149): the Email/set create object is
// identical between "submit now" and "save for later" — identity,
// recipients, subject, body values, attachments by blobId and threading
// headers — so it is built in one place and each route only supplies the
// mailboxIds/keywords that differ (see keywords/draftsMailboxId above).
function buildComposeEmailCreate(input: ComposeEmailInput): Record<string, unknown> {
  return {
    from: [{ name: input.identity.name || null, email: input.identity.email }],
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    keywords: input.keywords,
    mailboxIds: { [input.draftsMailboxId]: true },
    bodyValues: {
      t: { value: input.textBody },
      ...(input.htmlBody ? { h: { value: input.htmlBody } } : {}),
    },
    textBody: [{ partId: "t", type: "text/plain" }],
    ...(input.htmlBody ? { htmlBody: [{ partId: "h", type: "text/html" }] } : {}),
    ...(input.attachments.length > 0
      ? {
          attachments: input.attachments.map((a) => ({
            blobId: a.blobId,
            type: a.type,
            name: a.name,
            disposition: "attachment",
          })),
        }
      : {}),
    // Guard on length, not truthiness: [] is truthy in JavaScript, so a
    // plain `input.inReplyTo ? ...` would forward an empty array to
    // Email/set instead of omitting the property entirely.
    ...(input.inReplyTo?.length ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references?.length ? { references: input.references } : {}),
  };
}

// Whether `email` is genuinely a draft sitting in the account's Drafts
// mailbox, and therefore a legitimate target for the move-to-Trash cleanup
// POST /drafts performs on a superseded original.
//
// originalDraftId arrives from the client and proves nothing on its own: the
// web app routes ?compose=draft:<id> through buildEditDraft for ANY message
// in the opened thread (see MailPage.tsx), so an inbox or sent message can
// reach the route as the claimed "original". Without this check, saving from
// such a composer would move a real received message to Trash and report 200.
//
// Both halves are required. The $draft keyword alone would accept a draft the
// user already moved elsewhere, and membership of Drafts alone would accept
// any message filed there by a filter.
function isDraftInMailbox(email: JmapEmail | undefined, draftsMailboxId: string): boolean {
  if (!email) return false;
  return email.keywords?.["$draft"] === true && email.mailboxIds?.[draftsMailboxId] === true;
}

// Moves the draft a newly saved one supersedes into Trash. Called only after
// the replacement has been confirmed to exist, and never allowed to fail the
// save — see the call site for why.
async function trashSupersededDraft(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  originalDraftId: string;
  original: JmapEmail | undefined;
  draftsMailboxId: string;
  trashMailboxId: string;
}): Promise<void> {
  if (!isDraftInMailbox(input.original, input.draftsMailboxId)) {
    log("warn", "save draft: original is not a draft in Drafts, not trashing it", {
      originalDraftId: input.originalDraftId,
    });
    return;
  }

  const responses = await input.jmap.request(input.auth, input.session, [
    [
      "Email/set",
      {
        accountId: input.session.accountId,
        update: {
          [input.originalDraftId]: {
            [`mailboxIds/${input.draftsMailboxId}`]: null,
            [`mailboxIds/${input.trashMailboxId}`]: true,
          },
        },
      },
      "r",
    ],
  ]);

  const result = (responses[0]?.[1] ?? {}) as {
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, unknown>;
  };

  // Positive confirmation, the same way PATCH /messages/:id above does it:
  // mere absence from notUpdated is not success. A response that names the id
  // in neither map means the server never reported moving anything, and
  // reading that as "moved" would silently hide a leftover draft.
  const rejected = Boolean(result.notUpdated && input.originalDraftId in result.notUpdated);
  const confirmed = Boolean(result.updated && input.originalDraftId in result.updated);
  if (rejected || !confirmed) {
    log("warn", "save draft: original draft was not confirmed moved to Trash", {
      originalDraftId: input.originalDraftId,
      rejected,
    });
  }
}

export function createMailRouter(deps: MailDeps) {
  const router = new Hono<{ Variables: MailVariables }>();
  const baseFetch = deps.fetchFn ?? fetch;
  // GH #211: these three routes talk to Stalwart directly instead of through
  // the JMAP client, so the client's "a rejecting fetch means the dependency is
  // down" mapping did not reach them — a Stalwart that refuses the connection
  // answered 500 "internal" on the event stream and on attachments while every
  // other route already answered 502 stalwart_unavailable. Same wrapper, same
  // verdict, for every call this server makes to Stalwart.
  const uploadFetch = withStalwartTransportErrors(baseFetch);
  // GH #165: they also need their own deadline. It only covers
  // time-to-response-headers, which is what lets the event stream stay open
  // for as long as the client wants while still failing fast on a Stalwart
  // that accepts the connection and never answers.
  const fetchFn = withStalwartTransportErrors(
    withDeadlineFetch(baseFetch, "stalwart", deps.timeoutMs ?? DEFAULT_STALWART_TIMEOUT_MS),
  );

  router.use("*", requireSession(deps.sessions));

  router.get("/signatures", async (c) => {
    const user = c.get("user");
    const list = await deps.signatures.list(user.userId);
    return c.json(list);
  });

  router.post("/signatures", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = signatureInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const created = await deps.signatures.create(user.userId, parsed.data);
    return c.json(created);
  });

  router.put("/signatures/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = signatureInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const updated = await deps.signatures.update(user.userId, id, parsed.data);
    if (!updated) {
      return errorResponse(c, "not_found", 404);
    }
    return c.json(updated);
  });

  router.delete("/signatures/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const removed = await deps.signatures.remove(user.userId, id);
    if (!removed) {
      return errorResponse(c, "not_found", 404);
    }
    return c.json({ ok: true });
  });

  router.get("/preferences", async (c) => {
    const user = c.get("user");
    const preferences = await deps.userPreferences.get(user.userId);
    return c.json(preferences);
  });

  router.put("/preferences", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = userPreferencesUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const preferences = await deps.userPreferences.merge(user.userId, parsed.data);
    return c.json(preferences);
  });

  router.get("/mailboxes", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      [
        "Mailbox/get",
        {
          accountId: session.accountId,
          properties: ["id", "name", "parentId", "role", "sortOrder", "unreadEmails", "totalEmails"],
        },
        "0",
      ],
    ]);
    const list = (responses[0]?.[1].list ?? []) as JmapMailbox[];
    const mailboxes: Mailbox[] = list
      .map((m) => ({
        id: m.id,
        name: m.name,
        parentId: m.parentId ?? null,
        role: m.role ?? null,
        sortOrder: m.sortOrder ?? 0,
        unreadEmails: m.unreadEmails ?? 0,
        totalEmails: m.totalEmails ?? 0,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return c.json(mailboxes);
  });

  router.get("/identities", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      ["Identity/get", { accountId: session.accountId }, "0"],
    ]);
    const list = (responses[0]?.[1].list ?? []) as JmapIdentity[];
    const identities: Identity[] = list
      .filter((i) => i.email)
      .map((i) => ({
        id: i.id,
        name: i.name ?? "",
        email: i.email,
      }));
    return c.json(identities);
  });

  router.get("/events", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    if (!session.eventSourceUrl) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    const upstreamUrl = session.eventSourceUrl
      .replaceAll("{types}", "Email,Mailbox")
      .replaceAll("{closeafter}", "no")
      .replaceAll("{ping}", "30");

    const upstream = await fetchFn(upstreamUrl, {
      headers: {
        authorization: basicAuthHeader(c.get("jmapAuth")),
        accept: "text/event-stream",
      },
      signal: c.req.raw.signal,
    });

    if (!upstream.ok || !upstream.body) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    // This connection legitimately sits idle between Stalwart's 30s keepalive
    // pings, longer than Bun.serve's 10s global idleTimeout. Clear the idle
    // deadline for THIS socket only so it isn't force-closed and reconnect-
    // stormed (GH #204); the global default still guards every other route.
    clearIdleTimeout(c.req.raw);

    const headers = {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    };

    // GH #180: this subscription (types=Email,Mailbox) is where the server
    // learns mail arrived — once, instead of re-harvesting on every read. Tap
    // it so an Email state advance triggers a best-effort contact harvest,
    // while the bytes pass through to the client untouched. Only when a contacts
    // repo is wired; otherwise the stream is proxied exactly as before.
    const contacts = deps.contacts;
    const jmap = deps.jmap;
    if (contacts && jmap) {
      const user = c.get("user");
      const auth = c.get("jmapAuth");
      // The harvest runs whenever mail arrives, which is long after this
      // handler returned — carry the request's log context with it so its
      // diagnostics are still findable by this stream's traceId (GH #219).
      const logContext = currentLogContext();
      const tapped = tapEmailStateChanges({
        source: upstream.body,
        accountId: session.accountId,
        onEmailStateChange: () =>
          withLogContext(logContext, () =>
            harvestOnMailArrival({
              contacts,
              jmap,
              auth,
              session,
              userId: user.userId,
              ownerEmail: user.email,
            }),
          ),
      });
      return new Response(tapped, { headers });
    }

    return new Response(upstream.body, { headers });
  });

  router.post("/blobs", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    if (!session.uploadUrl) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    const uploadUrl = session.uploadUrl.replaceAll(
      "{accountId}",
      encodeURIComponent(session.accountId),
    );
    const contentType = c.req.header("content-type") ?? "application/octet-stream";

    // Deliberately the undeadlined fetch (GH #165): this is the one outbound
    // call whose response only arrives after the entire attachment has been
    // relayed upstream, so a fixed time-to-headers ceiling would reject large
    // attachments on slow uplinks — a worse, user-visible failure than the one
    // it would prevent. Bounding an upload needs a rate-aware budget, not this.
    // It is still wrapped for transport failures (GH #211).
    const upstream = await uploadFetch(uploadUrl, {
      method: "POST",
      headers: {
        authorization: basicAuthHeader(c.get("jmapAuth")),
        "content-type": contentType,
      },
      body: c.req.raw.body,
      duplex: "half",
    } as RequestInit);

    if (!upstream.ok) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    const body = (await upstream.json()) as { blobId?: string; type?: string; size?: number };
    const parsed = blobUploadResultSchema.safeParse({
      blobId: body.blobId,
      type: body.type ?? "application/octet-stream",
      size: body.size ?? 0,
    });
    if (!parsed.success) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    return c.json(parsed.data);
  });

  router.get("/blobs/:blobId", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    if (!session.downloadUrl) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    const blobId = c.req.param("blobId");
    const name = c.req.query("name") ?? "attachment";
    const type = c.req.query("type") ?? "application/octet-stream";
    const dl = c.req.query("dl");

    const downloadUrl = session.downloadUrl
      .replaceAll("{accountId}", encodeURIComponent(session.accountId))
      .replaceAll("{blobId}", encodeURIComponent(blobId))
      .replaceAll("{name}", encodeURIComponent(name))
      .replaceAll("{type}", encodeURIComponent(type));

    const range = c.req.header("range");
    const upstream = await fetchFn(downloadUrl, {
      headers: {
        authorization: basicAuthHeader(c.get("jmapAuth")),
        ...(range ? { range } : {}),
      },
      signal: c.req.raw.signal,
    });

    if (!upstream.ok || !upstream.body) {
      return errorResponse(c, "stalwart_unavailable", 502);
    }

    const resolvedContentType = upstream.headers.get("content-type") ?? type;
    const isSafeInline = SAFE_INLINE_CONTENT_TYPES.has(baseMimeType(resolvedContentType));

    const headers = new Headers();
    // Non-safe-listed types (html, svg, xml, octet-stream, etc.) are never echoed
    // back verbatim: neutralize to application/octet-stream so a browser won't
    // auto-render them even if the file is later reopened from disk.
    headers.set("content-type", isSafeInline ? resolvedContentType : "application/octet-stream");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("content-range", contentRange);
    const acceptRanges = upstream.headers.get("accept-ranges");
    if (acceptRanges) headers.set("accept-ranges", acceptRanges);
    headers.set("cache-control", "private, max-age=31536000, immutable");
    // Defense-in-depth against stored-XSS via attachment preview: even for
    // safe-listed types, disable script execution in the rendering context.
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy", "sandbox");
    // Only safe-listed content-types may render inline; everything else is
    // forced to download regardless of the `dl` query param.
    const disposition = dl === "1" || !isSafeInline ? "attachment" : "inline";
    headers.set(
      "content-disposition",
      `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    );

    return new Response(upstream.body, { status: upstream.status, headers });
  });

  router.get("/messages", requireMail(deps), async (c) => {
    const mailboxId = c.req.query("mailboxId");
    const hasKeywords =
      c.req
        .query("hasKeyword")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    if (!mailboxId && hasKeywords.length === 0) {
      return errorResponse(c, "invalid_query", 400);
    }
    if (hasKeywords.some((keyword) => !KEYWORD_PATTERN.test(keyword))) {
      return errorResponse(c, "invalid_query", 400);
    }
    const query = c.req.query("query");
    const to = c.req.query("to");
    const excludeTo =
      c.req
        .query("excludeTo")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const excludeMailboxId = c.req.query("excludeMailboxId");
    const position = Math.max(0, Number(c.req.query("position") ?? "0") || 0);
    const requestedLimit = Number(c.req.query("limit") ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));

    const session = c.get("jmapSession");
    const filter = buildMessagesFilter({ mailboxId, query, to, excludeTo, excludeMailboxId, hasKeywords });
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      [
        "Email/query",
        {
          accountId: session.accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          position,
          limit,
          calculateTotal: true,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: session.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [
            "id",
            "threadId",
            "mailboxIds",
            "from",
            "to",
            "subject",
            "receivedAt",
            "preview",
            "keywords",
            "hasAttachment",
            "size",
          ],
        },
        "g",
      ],
    ]);

    const queryResult = (responses[0]?.[1] ?? {}) as { ids?: string[]; total?: number; position?: number };
    const getResult = (responses[1]?.[1] ?? {}) as { list?: JmapEmail[] };

    const ids = queryResult.ids ?? [];
    const order = new Map(ids.map((id, i) => [id, i]));
    const list = getResult.list ?? [];
    const sorted = [...list].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );

    const page: MessagesPage = {
      total: queryResult.total ?? 0,
      position: queryResult.position ?? 0,
      emails: sorted.map(toEmailSummary),
    };

    // GH #180: contact harvesting used to run here, on every read. It now runs
    // once per delivery from the JMAP event subscription (see GET /events), so
    // this route no longer harvests — reading the inbox is not a "mail arrived"
    // signal.
    return c.json(page);
  });

  router.get("/threads/:threadId", requireMail(deps), async (c) => {
    const threadId = c.req.param("threadId");
    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      ["Thread/get", { accountId: session.accountId, ids: [threadId] }, "t"],
      [
        "Email/get",
        {
          accountId: session.accountId,
          "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
          properties: [
            "id",
            "threadId",
            "mailboxIds",
            "from",
            "to",
            "cc",
            "replyTo",
            "subject",
            "receivedAt",
            "preview",
            "keywords",
            "hasAttachment",
            "size",
            "htmlBody",
            "textBody",
            "bodyValues",
            "attachments",
            "messageId",
            "references",
            "inReplyTo",
            // GH #136: full ordered header list, used to derive the sender-
            // authenticity verdict — see sender-auth.ts and the JmapHeader
            // comment above for why the generic `headers` property is
            // requested instead of a narrower `header:X:asText` accessor.
            "headers",
          ],
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
          maxBodyValueBytes: 524288,
        },
        "g",
      ],
    ]);

    const threadResult = (responses[0]?.[1] ?? {}) as { list?: JmapThread[] };
    const threadList = threadResult.list ?? [];
    if (threadList.length === 0) {
      return errorResponse(c, "not_found", 404);
    }

    const getResult = (responses[1]?.[1] ?? {}) as { list?: JmapEmailDetail[] };
    const emails = [...(getResult.list ?? [])].sort(
      (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
    );

    const thread: ThreadDetail = {
      id: threadId,
      emails: emails.map(toEmailDetail),
    };
    return c.json(thread);
  });

  router.patch("/messages/:id", requireMail(deps), async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = emailUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.keywords) {
      for (const [key, value] of Object.entries(parsed.data.keywords)) {
        patch[`keywords/${key}`] = value === true ? true : null;
      }
    }
    if (parsed.data.mailboxIds) {
      patch.mailboxIds = parsed.data.mailboxIds;
    }

    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      ["Email/set", { accountId: session.accountId, update: { [id]: patch } }, "s"],
    ]);

    const setResult = (responses[0]?.[1] ?? {}) as {
      updated?: Record<string, unknown>;
      notUpdated?: Record<string, unknown>;
    };

    if (setResult.notUpdated && id in setResult.notUpdated) {
      return errorResponse(c, "update_failed", 409);
    }
    if (setResult.updated && id in setResult.updated) {
      return c.json({ ok: true });
    }

    return errorResponse(c, "update_failed", 409);
  });

  // GH #133: permanently destroys a message via Email/set `destroy`. This is
  // irreversible, so the route does not trust the client's claim that the id
  // it sends is actually sitting in Trash — the web app only ever offers
  // "Delete permanently" while viewing Trash, but that's a UI affordance, not
  // a security boundary, and an id can arrive here from anywhere. The same
  // lesson as the save-draft route's originalDraftId check above: trusting a
  // client-supplied id without verifying it server-side let that route trash
  // an arbitrary message. Here the stakes are higher (destroy, not move), so
  // the message's mailbox membership is looked up and checked BEFORE the
  // destroy is ever issued. The cost is one extra JMAP round trip (a batched
  // Mailbox/get + Email/get) ahead of the Email/set destroy call.
  //
  // Email/get is scoped to this session's own accountId, so a message
  // belonging to a different account never appears in the lookup — it comes
  // back as an empty list, indistinguishable from "no such message", and is
  // refused the same way as any id that isn't genuinely in Trash.
  router.delete("/messages/:id", requireMail(deps), async (c) => {
    const id = c.req.param("id");
    const session = c.get("jmapSession");
    const auth = c.get("jmapAuth");

    const lookup = await deps.jmap!.request(auth, session, [
      ["Mailbox/get", { accountId: session.accountId, properties: ["id", "role"] }, "m"],
      ["Email/get", { accountId: session.accountId, ids: [id], properties: ["id", "mailboxIds"] }, "e"],
    ]);

    const mailboxResult = (lookup[0]?.[1] ?? {}) as { list?: JmapMailbox[] };
    const trashId = (mailboxResult.list ?? []).find((m) => m.role === "trash")?.id;

    const emailResult = (lookup[1]?.[1] ?? {}) as { list?: JmapEmail[] };
    const email = (emailResult.list ?? [])[0];

    const isInTrash = Boolean(trashId && email?.mailboxIds?.[trashId] === true);
    if (!isInTrash) {
      return errorResponse(c, "not_in_trash", 409);
    }

    const responses = await deps.jmap!.request(auth, session, [
      ["Email/set", { accountId: session.accountId, destroy: [id] }, "d"],
    ]);

    const setResult = (responses[0]?.[1] ?? {}) as {
      destroyed?: string[];
      notDestroyed?: Record<string, unknown>;
    };

    // Same rigor PATCH /messages/:id applies above: check the negative
    // (notDestroyed) first, then require a positive confirmation (id present
    // in `destroyed`) before reporting success — a response that names the
    // id in neither is not proof anything was actually destroyed.
    if (setResult.notDestroyed && id in setResult.notDestroyed) {
      return errorResponse(c, "destroy_failed", 409);
    }
    if (setResult.destroyed && setResult.destroyed.includes(id)) {
      return c.json({ ok: true });
    }

    return errorResponse(c, "destroy_failed", 409);
  });

  router.post("/send", requireMail(deps), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = sendEmailSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const input = parsed.data;

    const session = c.get("jmapSession");
    const auth = c.get("jmapAuth");

    const context = await lookupComposeContext(deps.jmap!, auth, session, input.identityId);
    if (!context) {
      return errorResponse(c, "invalid_identity", 400);
    }
    const { identity, mailboxes } = context;

    const draftsId = mailboxes.find((m) => m.role === "drafts")?.id;
    const sentId = mailboxes.find((m) => m.role === "sent")?.id;
    if (!draftsId || !sentId) {
      return errorResponse(c, "mailbox_roles_missing", 502);
    }

    const create = buildComposeEmailCreate({
      identity,
      draftsMailboxId: draftsId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      attachments: input.attachments,
      inReplyTo: input.inReplyTo,
      references: input.references,
      keywords: { $seen: true },
    });

    const sendResponses = await deps.jmap!.request(auth, session, [
      ["Email/set", { accountId: session.accountId, create: { draft: create } }, "e"],
      [
        "EmailSubmission/set",
        {
          accountId: session.accountId,
          create: { sub: { emailId: "#draft", identityId: input.identityId } },
          onSuccessUpdateEmail: {
            "#sub": {
              [`mailboxIds/${draftsId}`]: null,
              [`mailboxIds/${sentId}`]: true,
              "keywords/$draft": null,
            },
          },
        },
        "s",
      ],
    ]);

    const emailSetResult = (sendResponses[0]?.[1] ?? {}) as {
      created?: Record<string, { id?: string }>;
      notCreated?: Record<string, unknown>;
    };
    const submissionResult = (sendResponses[1]?.[1] ?? {}) as {
      notCreated?: Record<string, unknown>;
      created?: Record<string, unknown>;
    };
    // RFC 8621 §7.5: onSuccessUpdateEmail is applied by a SEPARATE implicit
    // Email/set that the server runs AFTER the submission and appends to the
    // response array under the EmailSubmission/set method-call id ("s"). This
    // third response — never inspected before — is the only place that reports
    // whether the just-sent message was actually moved to Sent and un-flagged
    // as a draft.
    const onSuccessUpdateResult = (sendResponses[2]?.[1] ?? {}) as {
      updated?: Record<string, unknown>;
      notUpdated?: Record<string, unknown>;
    };

    // Positive confirmation, matching the draft-save (#149) and destroy (#133)
    // paths: an empty notCreated is NOT proof of success. The draft must appear
    // in `created` (its id is what the submission's #draft back-reference
    // resolves to) and the submission must appear in `created` before the mail
    // is treated as sent. Without both, nothing left the outbox — report the
    // failure rather than a phantom success that would hide a non-delivery.
    const draftId = emailSetResult.created?.draft?.id;
    const submissionCreated = Boolean(submissionResult.created && "sub" in submissionResult.created);
    if (
      (emailSetResult.notCreated && "draft" in emailSetResult.notCreated) ||
      !draftId ||
      (submissionResult.notCreated && "sub" in submissionResult.notCreated) ||
      !submissionCreated
    ) {
      return errorResponse(c, "send_failed", 502);
    }

    // The submission is confirmed, so the mail HAS gone out. RFC 8620 §5.3
    // makes the implicit onSuccessUpdateEmail non-transactional with respect to
    // the submission, so the move to Sent / $draft-clear can still have failed.
    // If it did not positively confirm the draft's update, erroring now would
    // be wrong twice over: it would claim the send failed when it did not, and
    // it would leave the sent message in Drafts still flagged $draft — a fresh,
    // re-sendable draft that invites a duplicate delivery. Instead, best-effort
    // re-apply the same idempotent patch (as the draft-replace path does for
    // its own non-transactional cleanup) so the sent message stops reading as a
    // draft, and still report the send as successful.
    const updateConfirmed = Boolean(
      onSuccessUpdateResult.updated && draftId in onSuccessUpdateResult.updated,
    );
    if (!updateConfirmed) {
      try {
        const remediation = await deps.jmap!.request(auth, session, [
          [
            "Email/set",
            {
              accountId: session.accountId,
              update: {
                [draftId]: {
                  [`mailboxIds/${draftsId}`]: null,
                  [`mailboxIds/${sentId}`]: true,
                  "keywords/$draft": null,
                },
              },
            },
            "u",
          ],
        ]);
        const remediationResult = (remediation[0]?.[1] ?? {}) as {
          updated?: Record<string, unknown>;
        };
        if (!(remediationResult.updated && draftId in remediationResult.updated)) {
          log("warn", "send: post-submission move to Sent could not be confirmed after remediation", {
            emailId: draftId,
          });
        }
      } catch {
        log("warn", "send: remediation of the post-submission move to Sent threw", {
          emailId: draftId,
        });
      }
    }

    return c.json({ ok: true });
  });

  // GH #149: creates the same kind of message /send does, but leaves it in
  // Drafts instead of submitting it — no EmailSubmission/set is ever issued
  // here, which is the whole difference from /send above.
  router.post("/drafts", requireMail(deps), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = saveDraftSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const input = parsed.data;

    const session = c.get("jmapSession");
    const auth = c.get("jmapAuth");

    const context = await lookupComposeContext(deps.jmap!, auth, session, input.identityId);
    if (!context) {
      return errorResponse(c, "invalid_identity", 400);
    }
    const { identity, mailboxes } = context;

    const draftsId = mailboxes.find((m) => m.role === "drafts")?.id;
    if (!draftsId) {
      return errorResponse(c, "mailbox_roles_missing", 502);
    }

    // The trash role is needed only to clean up a superseded original, and is
    // deliberately NOT a precondition for saving: an account whose Trash
    // mailbox is missing must still be able to store the user's work. Making
    // an impossible tidy-up block the save would refuse to save for a reason
    // that has nothing to do with the draft itself.
    const trashId = mailboxes.find((m) => m.role === "trash")?.id;
    const replaceTarget =
      input.originalDraftId && trashId
        ? { originalDraftId: input.originalDraftId, trashId }
        : null;

    const create = buildComposeEmailCreate({
      identity,
      draftsMailboxId: draftsId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      attachments: input.attachments,
      inReplyTo: input.inReplyTo,
      references: input.references,
      // $draft marks this message as a draft in JMAP. /send never sets it
      // explicitly because the message it creates is submitted and moved to
      // Sent in the same request (see onSuccessUpdateEmail's
      // "keywords/$draft": null above) — but a saved draft is never
      // submitted, so nothing else will ever set it. $seen mirrors what
      // /send sets: the message was authored by the user, not received.
      keywords: { $draft: true, $seen: true },
    });

    // RFC 8620 §5.3: Email/set is NOT transactional across `create` and
    // `update`. Without `ifInState` — which this route does not pass, since it
    // has no state token to pin — the server applies each record
    // independently and reports them separately in notCreated/notUpdated.
    // Carrying the new draft's create and the original's move-to-Trash in one
    // call therefore permits "original trashed, replacement never created":
    // the user's work vanishes into Trash while the route answers 502, with
    // nothing to tell them where it went.
    //
    // So the create goes out alone and is confirmed below before anything
    // touches the original. The worst remaining outcome is a leftover
    // duplicate draft — visible in Drafts and recoverable — instead of a lost
    // one. The Email/get rides along in the same request only because it is
    // read-only and cannot affect the create; it saves a round trip without
    // reintroducing the coupling.
    const draftResponses = await deps.jmap!.request(auth, session, [
      ["Email/set", { accountId: session.accountId, create: { draft: create } }, "e"],
      ...(replaceTarget
        ? ([
            [
              "Email/get",
              {
                accountId: session.accountId,
                ids: [replaceTarget.originalDraftId],
                properties: ["id", "mailboxIds", "keywords"],
              },
              "o",
            ],
          ] satisfies JmapMethodCall[])
        : []),
    ]);

    const emailSetResult = (draftResponses[0]?.[1] ?? {}) as {
      created?: Record<string, { id?: string }>;
      notCreated?: Record<string, unknown>;
    };
    const createdId = emailSetResult.created?.draft?.id;

    if ((emailSetResult.notCreated && "draft" in emailSetResult.notCreated) || !createdId) {
      return errorResponse(c, "save_draft_failed", 502);
    }

    if (replaceTarget) {
      // Best-effort, exactly like the send path's cleanup of the same stale
      // original (see apps/web/src/features/composer/useComposer.ts): the
      // draft the user asked to save already exists by now, so a failure to
      // tidy up the superseded original must never surface as a save failure.
      // Returning 502 here would tell the user their work was not saved when
      // it was — and invite them to retry, producing another duplicate.
      try {
        const originalResult = (draftResponses[1]?.[1] ?? {}) as { list?: JmapEmail[] };
        await trashSupersededDraft({
          jmap: deps.jmap!,
          auth,
          session,
          originalDraftId: replaceTarget.originalDraftId,
          original: (originalResult.list ?? [])[0],
          draftsMailboxId: draftsId,
          trashMailboxId: replaceTarget.trashId,
        });
      } catch {
        log("warn", "save draft: trashing the original draft threw", {
          originalDraftId: replaceTarget.originalDraftId,
        });
      }
    }

    return c.json(saveDraftResultSchema.parse({ id: createdId }));
  });

  return router;
}

export type MailRouter = ReturnType<typeof createMailRouter>;
