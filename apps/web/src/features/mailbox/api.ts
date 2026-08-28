import {
  instanceSettingsViewSchema, mailboxSchema, messagesPageSchema, sharedAccountSchema, sharedAccountsSchema,
  threadDetailSchema,
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

// Exported so callers outside the mail feature that share this same ApiError
// envelope shape (GH #341: useAuth's /api/auth/me) can throw the same
// MailApiError instead of re-implementing the code-extraction dance.
export async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

// GH #13/#50: the one cache key for the shared-mailbox list, shared by the
// "Buzones compartidos" page, the mail view banner and (since #340) the
// sidebar's group rows, so all three read one entry instead of each declaring
// their own copy of it.
export const SHARED_ACCOUNTS_QUERY_KEY = ["mail", "shared-accounts"] as const;

// GH #13/#50: the shared mailboxes the signed-in member can browse — the
// non-personal accounts Stalwart lists in their JMAP session. The account
// selector reads this to offer them; personal is never in the list.
export async function fetchSharedAccounts(): Promise<SharedAccount[]> {
  const res = await fetch("/api/mail/shared-accounts");
  if (!res.ok) return parseError(res);
  return sharedAccountsSchema.parse(await res.json());
}

// GH #13/#50 (G-3): sets whether the member wants copies of new mail from a
// shared mailbox delivered to their own inbox (PUT
// /api/mail/shared-accounts/:id/copy-preference). The server persists the
// intent only — no copy is delivered from this yet — and returns the updated
// shared account. `id` must be a shared, non-personal account the member can
// reach (the server refuses a personal/unreachable id).
export async function setSharedAccountCopyPreference(
  id: string,
  copyOptIn: boolean,
): Promise<SharedAccount> {
  const res = await fetch(`/api/mail/shared-accounts/${encodeURIComponent(id)}/copy-preference`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ copyOptIn }),
  });
  if (!res.ok) return parseError(res);
  return sharedAccountSchema.parse(await res.json());
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

// #343: the list and the reader work on CONVERSATIONS, so archiving, moving to
// Trash or restoring one has to act on every message of the thread that sits in
// the mailbox being viewed — acting on the newest message alone left the row in
// Recibidos, now showing the previous message of the same conversation.
//
// The server exposes no batch update (PATCH /api/mail/messages/:id is strictly
// per message, see apps/server/src/modules/mail/router.ts), so this issues one
// request per id. `allSettled` rather than `all`: a rejection must not abandon
// the requests already in flight and leave the conversation half-moved. The
// first rejection is re-thrown so the caller's onError reports it — and, in
// particular, so a 401 still reaches the session revalidation.
export async function updateMessages(
  ids: string[],
  update: EmailUpdate,
  accountId?: string,
): Promise<void> {
  const results = await Promise.allSettled(ids.map((id) => updateMessage(id, update, accountId)));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
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

// #343: the destroy counterpart of updateMessages above — same per-id fan-out,
// same first-rejection-wins reporting. Only ever called on messages already in
// Trash (the server refuses anything else).
export async function destroyMessages(ids: string[], accountId?: string): Promise<void> {
  const results = await Promise.allSettled(ids.map((id) => destroyMessage(id, accountId)));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
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
