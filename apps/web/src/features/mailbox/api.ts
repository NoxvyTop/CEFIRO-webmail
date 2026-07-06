import {
  mailboxSchema, messagesPageSchema, threadDetailSchema,
  type EmailUpdate, type Mailbox, type MessagesPage, type ThreadDetail,
} from "@webmail/shared";
import { z } from "zod";

export class MailApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "MailApiError";
  }
}

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

export async function fetchMailboxes(): Promise<Mailbox[]> {
  const res = await fetch("/api/mail/mailboxes");
  if (!res.ok) return parseError(res);
  return z.array(mailboxSchema).parse(await res.json());
}

export async function fetchMessages(input: {
  mailboxId: string; position: number; limit: number; query?: string;
}): Promise<MessagesPage> {
  const params = new URLSearchParams({
    mailboxId: input.mailboxId,
    position: String(input.position),
    limit: String(input.limit),
  });
  if (input.query) params.set("query", input.query);
  const res = await fetch(`/api/mail/messages?${params}`);
  if (!res.ok) return parseError(res);
  return messagesPageSchema.parse(await res.json());
}

export async function fetchThread(threadId: string): Promise<ThreadDetail> {
  const res = await fetch(`/api/mail/threads/${encodeURIComponent(threadId)}`);
  if (!res.ok) return parseError(res);
  return threadDetailSchema.parse(await res.json());
}

export async function updateMessage(id: string, update: EmailUpdate): Promise<void> {
  const res = await fetch(`/api/mail/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) return parseError(res);
}

export const PAGE_SIZE = 50;
