import {
  instanceSettingsViewSchema, mailboxSchema, messagesPageSchema, sharedAccountsSchema, threadDetailSchema,
  type EmailUpdate, type InstanceSettingsView, type Mailbox, type MessagesPage, type SharedAccount, type ThreadDetail,
} from "@webmail/shared";
import { z } from "zod";

export class MailApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "MailApiError";
  }
}

// GH #13/#50: the URL search param that carries the active shared mailbox in
// the SPA. Absent means the personal mailbox — the default — so nothing about
// the personal experience changes. When present it is threaded into every mail
// request below as `?accountId=`, which the server (resolveAccountId) scopes to
// that shared account. Shared here so the selector, MailPage and the query keys
// all name it one way.
export const ACTIVE_ACCOUNT_PARAM = "account";

// The `?accountId=` suffix for a mail request, or "" for the personal mailbox —
// keeping personal requests byte-identical to before shared mailboxes existed.
function accountQuery(accountId?: string): string {
  return accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
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

// GH #13/#50: the shared mailboxes the signed-in member can browse — the
// non-personal accounts Stalwart lists in their JMAP session. The account
// selector reads this to offer them; personal is never in the list.
export async function fetchSharedAccounts(): Promise<SharedAccount[]> {
  const res = await fetch("/api/mail/shared-accounts");
  if (!res.ok) return parseError(res);
  return sharedAccountsSchema.parse(await res.json());
}

export async function fetchMailboxes(accountId?: string): Promise<Mailbox[]> {
  const res = await fetch(`/api/mail/mailboxes${accountQuery(accountId)}`);
  if (!res.ok) return parseError(res);
  return z.array(mailboxSchema).parse(await res.json());
}

export async function fetchMessages(input: {
  mailboxId?: string; hasKeyword?: string; position: number; limit: number; query?: string;
  to?: string; excludeTo?: string[]; excludeMailboxId?: string; accountId?: string;
}): Promise<MessagesPage> {
  const params = new URLSearchParams({
    position: String(input.position),
    limit: String(input.limit),
  });
  if (input.mailboxId) params.set("mailboxId", input.mailboxId);
  if (input.hasKeyword) params.set("hasKeyword", input.hasKeyword);
  if (input.query) params.set("query", input.query);
  if (input.to) params.set("to", input.to);
  if (input.excludeTo && input.excludeTo.length > 0) params.set("excludeTo", input.excludeTo.join(","));
  if (input.excludeMailboxId) params.set("excludeMailboxId", input.excludeMailboxId);
  if (input.accountId) params.set("accountId", input.accountId);
  const res = await fetch(`/api/mail/messages?${params}`);
  if (!res.ok) return parseError(res);
  return messagesPageSchema.parse(await res.json());
}

export async function fetchThread(threadId: string, accountId?: string): Promise<ThreadDetail> {
  const res = await fetch(`/api/mail/threads/${encodeURIComponent(threadId)}${accountQuery(accountId)}`);
  if (!res.ok) return parseError(res);
  return threadDetailSchema.parse(await res.json());
}

export async function updateMessage(id: string, update: EmailUpdate, accountId?: string): Promise<void> {
  const res = await fetch(`/api/mail/messages/${encodeURIComponent(id)}${accountQuery(accountId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) return parseError(res);
}

// GH #133: permanently destroys a message via DELETE /api/mail/messages/:id
// (Email/set `destroy` on the server). Irreversible — the server refuses
// unless the message is actually sitting in Trash; the caller must only ever
// offer this from the Trash view (see ThreadView.tsx's showDeletePermanently)
// and gate it behind an explicit confirmation.
export async function destroyMessage(id: string, accountId?: string): Promise<void> {
  const res = await fetch(`/api/mail/messages/${encodeURIComponent(id)}${accountQuery(accountId)}`, {
    method: "DELETE",
  });
  if (!res.ok) return parseError(res);
}

// GH #13/#50 (G-2): copies a message from a shared mailbox into the member's
// OWN personal inbox (POST /api/mail/messages/:id/copy-to-inbox on the server,
// a single JMAP Email/copy with the member's own credential). `accountId` is
// REQUIRED and must be the shared account the message is being read from — the
// server refuses a personal/own account with 400 invalid_account. The original
// stays put in the shared mailbox.
export async function copyMessageToInbox(id: string, accountId: string): Promise<void> {
  const res = await fetch(
    `/api/mail/messages/${encodeURIComponent(id)}/copy-to-inbox${accountQuery(accountId)}`,
    { method: "POST" },
  );
  if (!res.ok) return parseError(res);
}

// Public, unauthenticated instance branding flag (see apps/server/src/app.ts
// GET /api/instance) — read by the reader footer, not admin-gated.
export async function fetchInstanceSettings(): Promise<InstanceSettingsView> {
  const res = await fetch("/api/instance");
  if (!res.ok) return parseError(res);
  return instanceSettingsViewSchema.parse(await res.json());
}

export const PAGE_SIZE = 50;
