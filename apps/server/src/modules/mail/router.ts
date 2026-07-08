import { Hono } from "hono";
import {
  blobUploadResultSchema,
  emailUpdateSchema,
  identitySchema,
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
import { requireMail, type MailDeps, type MailVariables } from "./context";

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
};

type JmapEmailDetail = JmapEmail & {
  cc?: JmapEmailAddress[];
  replyTo?: JmapEmailAddress[];
  htmlBody?: JmapBodyPart[];
  textBody?: JmapBodyPart[];
  bodyValues?: Record<string, JmapBodyValue>;
  attachments?: JmapAttachment[];
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

export function createMailRouter(deps: MailDeps) {
  const router = new Hono<{ Variables: MailVariables }>();
  const fetchFn = deps.fetchFn ?? fetch;

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
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = signatureInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
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
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = signatureInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const updated = await deps.signatures.update(user.userId, id, parsed.data);
    if (!updated) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    return c.json(updated);
  });

  router.delete("/signatures/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const removed = await deps.signatures.remove(user.userId, id);
    if (!removed) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
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
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = userPreferencesUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
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
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
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
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
    }

    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  });

  router.post("/blobs", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    if (!session.uploadUrl) {
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
    }

    const uploadUrl = session.uploadUrl.replaceAll(
      "{accountId}",
      encodeURIComponent(session.accountId),
    );
    const contentType = c.req.header("content-type") ?? "application/octet-stream";

    const upstream = await fetchFn(uploadUrl, {
      method: "POST",
      headers: {
        authorization: basicAuthHeader(c.get("jmapAuth")),
        "content-type": contentType,
      },
      body: c.req.raw.body,
      duplex: "half",
    } as RequestInit);

    if (!upstream.ok) {
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
    }

    const body = (await upstream.json()) as { blobId?: string; type?: string; size?: number };
    const parsed = blobUploadResultSchema.safeParse({
      blobId: body.blobId,
      type: body.type ?? "application/octet-stream",
      size: body.size ?? 0,
    });
    if (!parsed.success) {
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
    }

    return c.json(parsed.data);
  });

  router.get("/blobs/:blobId", requireMail(deps), async (c) => {
    const session = c.get("jmapSession");
    if (!session.downloadUrl) {
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
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
      return c.json(
        { code: "stalwart_unavailable", message: "errors.stalwart_unavailable", traceId: c.get("traceId") },
        502,
      );
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
      return c.json(
        { code: "invalid_query", message: "errors.invalid_query", traceId: c.get("traceId") },
        400,
      );
    }
    if (hasKeywords.some((keyword) => !KEYWORD_PATTERN.test(keyword))) {
      return c.json(
        { code: "invalid_query", message: "errors.invalid_query", traceId: c.get("traceId") },
        400,
      );
    }
    const query = c.req.query("query");
    const to = c.req.query("to");
    const excludeTo =
      c.req
        .query("excludeTo")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const position = Number(c.req.query("position") ?? "0") || 0;
    const requestedLimit = Number(c.req.query("limit") ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT;
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    const session = c.get("jmapSession");
    const filter = buildMessagesFilter({ mailboxId, query, to, excludeTo, hasKeywords });
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
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
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
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = emailUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
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
      return c.json(
        { code: "update_failed", message: "errors.update_failed", traceId: c.get("traceId") },
        409,
      );
    }
    if (setResult.updated && id in setResult.updated) {
      return c.json({ ok: true });
    }

    return c.json(
      { code: "update_failed", message: "errors.update_failed", traceId: c.get("traceId") },
      409,
    );
  });

  router.post("/send", requireMail(deps), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = sendEmailSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const input = parsed.data;

    const session = c.get("jmapSession");
    const auth = c.get("jmapAuth");

    const lookup = await deps.jmap!.request(auth, session, [
      ["Identity/get", { accountId: session.accountId, ids: [input.identityId] }, "i"],
      ["Mailbox/get", { accountId: session.accountId, properties: ["id", "role"] }, "m"],
    ]);

    const identityResult = (lookup[0]?.[1] ?? {}) as { list?: JmapIdentity[] };
    const identity = (identityResult.list ?? [])[0];
    if (!identity) {
      return c.json(
        { code: "invalid_identity", message: "errors.invalid_identity", traceId: c.get("traceId") },
        400,
      );
    }

    const mailboxResult = (lookup[1]?.[1] ?? {}) as { list?: JmapMailbox[] };
    const mailboxList = mailboxResult.list ?? [];
    const draftsId = mailboxList.find((m) => m.role === "drafts")?.id;
    const sentId = mailboxList.find((m) => m.role === "sent")?.id;
    if (!draftsId || !sentId) {
      return c.json(
        { code: "mailbox_roles_missing", message: "errors.mailbox_roles_missing", traceId: c.get("traceId") },
        502,
      );
    }

    const create: Record<string, unknown> = {
      from: [{ name: identity.name || null, email: identity.email }],
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      keywords: { $seen: true },
      mailboxIds: { [draftsId]: true },
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
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references ? { references: input.references } : {}),
    };

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

    const emailSetResult = (sendResponses[0]?.[1] ?? {}) as { notCreated?: Record<string, unknown> };
    const submissionResult = (sendResponses[1]?.[1] ?? {}) as {
      notCreated?: Record<string, unknown>;
      created?: Record<string, unknown>;
    };

    if (
      (emailSetResult.notCreated && "draft" in emailSetResult.notCreated) ||
      (submissionResult.notCreated && "sub" in submissionResult.notCreated)
    ) {
      return c.json(
        { code: "send_failed", message: "errors.send_failed", traceId: c.get("traceId") },
        502,
      );
    }

    return c.json({ ok: true });
  });

  return router;
}

export type MailRouter = ReturnType<typeof createMailRouter>;
