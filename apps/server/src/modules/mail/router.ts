import { Hono } from "hono";
import type {
  AttachmentMeta,
  EmailAddress,
  EmailDetail,
  EmailSummary,
  Mailbox,
  MessagesPage,
  ThreadDetail,
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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

export function createMailRouter(deps: MailDeps) {
  const router = new Hono<{ Variables: MailVariables }>();

  router.use("*", requireSession(deps.sessions));
  router.use("*", requireMail(deps));

  router.get("/mailboxes", async (c) => {
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

  router.get("/messages", async (c) => {
    const mailboxId = c.req.query("mailboxId");
    if (!mailboxId) {
      return c.json(
        { code: "invalid_query", message: "errors.invalid_query", traceId: c.get("traceId") },
        400,
      );
    }
    const query = c.req.query("query");
    const position = Number(c.req.query("position") ?? "0") || 0;
    const requestedLimit = Number(c.req.query("limit") ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT;
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    const session = c.get("jmapSession");
    const filter = query ? { inMailbox: mailboxId, text: query } : { inMailbox: mailboxId };
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

  router.get("/threads/:threadId", async (c) => {
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

  return router;
}

export type MailRouter = ReturnType<typeof createMailRouter>;
