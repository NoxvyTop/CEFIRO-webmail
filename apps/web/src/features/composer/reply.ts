import {
  MAX_MESSAGE_ID_COUNT,
  messageIdSchema,
  type EmailAddress,
  type EmailDetail,
  type Identity,
} from "@webmail/shared";
import { sanitizeEmailHtml } from "../reader/sanitize";
import { QUOTE_MARKER_ATTR } from "./signature";

export type DraftAttachment = { blobId: string; name: string; type: string; size: number };

// GH #269: which flow produced this draft, so the composer can announce and
// title itself for what it actually is (reply/forward/edit) instead of always
// "New message". This is the same distinction #145 keys the composer's remount
// on — the compose param's prefix (reply / reply-all / forward / draft / new) —
// carried on the draft itself rather than re-derived from its fields, since the
// builders below already know it for certain (a reply-all with no extra
// recipients, say, is otherwise indistinguishable from a plain reply).
export type ComposeMode = "new" | "reply" | "reply-all" | "forward" | "draft";

export type ComposerDraft = {
  identityId: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  // RFC 5322 §3.6.4 threading headers (In-Reply-To / References), populated
  // by replyDraft from the parent message's own Message-ID, References and
  // In-Reply-To (see EmailDetail.messageId/.references/.inReplyTo in
  // packages/shared/src/api/mail.ts) so replies thread correctly in the
  // recipient's mail client, and restored by buildEditDraft from the reopened
  // draft's own stored headers (GH #146). Left unset by forwardDraft, which
  // starts a new conversation rather than continuing one.
  inReplyTo?: string[];
  references?: string[];
  // present only on forward drafts: original attachments reattached by blobId
  attachments?: DraftAttachment[];
  // present only when editing an existing draft (compose=draft:<id>): the id
  // of the original JMAP draft being edited, so a successful send can trash
  // the stale copy instead of leaving it behind (see useComposer.ts send()).
  originalDraftId?: string;
  // GH #269: the flow this draft was built for — see ComposeMode above. Set by
  // every builder in this file; a bare draft literal (test fixtures) that omits
  // it is treated as "new". Purely presentational: it is deliberately excluded
  // from buildComposePayload/serializeDraftPayload (useComposer.ts), so it never
  // reaches the wire or the autosave fingerprint.
  mode?: ComposeMode;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function dedupeAddresses(addresses: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const result: EmailAddress[] = [];
  for (const address of addresses) {
    const key = normalizeEmail(address.email);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

// A malformed/duplicated upstream References chain is non-conformant with
// RFC 5322, so collapse repeats defensively while preserving first-seen
// order (References is meaningful as an ordered ancestry list).
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

// Drops the individual ids sendEmailSchema would reject — empty, over-long,
// or carrying a control character — validating against that exact schema so
// the two rules cannot drift. Dropping one id costs a single ancestry link
// and degrades threading slightly; letting it through costs the user the
// whole reply, because the send is rejected client-side (composer/api.ts
// parses the payload before it builds the request) and surfaces only as a
// generic error.
function keepSendableIds(ids: string[]): string[] {
  return ids.filter((id) => messageIdSchema.safeParse(id).success);
}

// A References chain grows by one id per reply and is inherited verbatim from
// the parent, so a long-lived thread eventually carries more ids than
// sendEmailSchema accepts. Keeps the first id — the conversation's anchor,
// which is what receiving clients use to attach the reply to the thread root
// — plus the most recent ids, dropping the middle, matching what Gmail and
// Outlook do. Trimming happens here rather than in the schema so an inherited
// chain is already within bounds by the time the draft reaches validation;
// the schema bound stays as a backstop for hand-crafted direct API calls.
function trimMessageIdChain(ids: string[]): string[] {
  if (ids.length <= MAX_MESSAGE_ID_COUNT) return ids;
  const [anchor, ...rest] = ids;
  if (anchor === undefined) return ids;
  return [anchor, ...rest.slice(rest.length - (MAX_MESSAGE_ID_COUNT - 1))];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pickIdentity(email: EmailDetail, identities: Identity[]): Identity | undefined {
  const recipientEmails = new Set(
    [...email.to, ...email.cc].map((address) => normalizeEmail(address.email)),
  );
  return (
    identities.find((identity) => recipientEmails.has(normalizeEmail(identity.email))) ??
    identities[0]
  );
}

// A draft was authored by us, so — unlike replyDraft/forwardDraft, which
// match an identity against who *received* the original — the signal here is
// who the draft's own From address belongs to.
function pickIdentityByFrom(email: EmailDetail, identities: Identity[]): Identity | undefined {
  const fromEmails = new Set(email.from.map((address) => normalizeEmail(address.email)));
  return (
    identities.find((identity) => fromEmails.has(normalizeEmail(identity.email))) ?? identities[0]
  );
}

function deriveSubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function deriveForwardSubject(subject: string): string {
  return /^fwd:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function quotedBody(email: EmailDetail): string {
  const rawHtml = email.bodyHtml ?? escapeHtml(email.bodyText ?? "");
  const sanitized = sanitizeEmailHtml(rawHtml, { allowRemoteImages: false });
  const sender = email.from[0];
  const senderLabel = sender ? sender.name || sender.email : "";
  const attribution = `<p>${escapeHtml(email.receivedAt)} — ${escapeHtml(senderLabel)}:</p>`;
  // GH #140, second half: the body handed to us may be a prefix of the real
  // message (see EmailDetail.bodyTruncated). Quoting it unmarked is what made
  // the loss permanent — from that reply onward the thread carries the cut
  // version as if it were the whole history, and nobody downstream can tell.
  // Marking it keeps the reply honest about what it is actually quoting.
  //
  // "[…]" rather than a sentence because this string ships inside an outgoing
  // email: reply.ts is a pure builder with no i18n context, and the bracketed
  // ellipsis is the long-standing, language-independent convention for elided
  // quoted text — so it reads correctly whatever language the thread is in.
  const elision = email.bodyTruncated ? "<p>[&hellip;]</p>" : "";
  // Wrapped in a marked container so composer/signature.ts can place the
  // auto-applied default signature above the whole quoted block (Gmail
  // model) instead of guessing based on the raw <blockquote> tag, which
  // could also appear inside the quoted original itself (nested quotes).
  return `<div ${QUOTE_MARKER_ATTR}="true"><br><br>${attribution}<blockquote>${sanitized.html}${elision}</blockquote></div>`;
}

export function emptyDraft(identities: Identity[]): ComposerDraft {
  return {
    identityId: identities[0]?.id ?? "",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    bodyHtml: "",
    mode: "new",
  };
}

/**
 * Who a reply is addressed to, with no body work.
 *
 * Split out of replyDraft so the reader can ask "would reply-all actually add
 * anyone?" without paying for a quoted body — answering that used to mean
 * running DOMParser and DOMPurify over the whole message on every render.
 *
 * It is deliberately the SAME computation replyDraft uses rather than a
 * second predicate beside it: the two had already drifted once (GH #174),
 * disagreeing on every message carrying Reply-To, under a comment asserting
 * they matched.
 */
export function replyRecipients(
  email: EmailDetail,
  identities: Identity[],
  all: boolean,
): { identityId: string; to: EmailAddress[]; cc: EmailAddress[] } {
  const ownKeys = new Set(identities.map((identity) => normalizeEmail(identity.email)));

  // Who to address the reply to. Normally the sender (or an explicit Reply-To),
  // but when the message is one the user *sent* — its From is entirely their
  // own addresses — replying to the sender would address the reply to
  // themselves. The reader's toolbar Reply acts on the newest message in a
  // thread, which is often one's own, so this is a common path, not an edge
  // case (GH #186). In that case continue the conversation with whoever the
  // message went to instead, dropping the user's own addresses; fall back to
  // the sender only if it turns out the message was sent solely to oneself.
  const isOwnMessage =
    email.from.length > 0 && email.from.every((a) => ownKeys.has(normalizeEmail(a.email)));
  let to: EmailAddress[];
  if (email.replyTo.length) {
    to = dedupeAddresses(email.replyTo);
  } else if (isOwnMessage) {
    const originalRecipients = dedupeAddresses(email.to).filter(
      (a) => !ownKeys.has(normalizeEmail(a.email)),
    );
    to = originalRecipients.length > 0 ? originalRecipients : dedupeAddresses(email.from);
  } else {
    to = dedupeAddresses(email.from);
  }

  const identity = pickIdentity(email, identities);
  const identityId = identity?.id ?? identities[0]?.id ?? "";

  let cc: EmailAddress[] = [];
  if (all) {
    const toKeys = new Set(to.map((address) => normalizeEmail(address.email)));
    // Exclude every one of the user's own addresses, not just the identity that
    // happened to be picked: with more than one identity, a message sent to two
    // of them would otherwise cc the user back on their own reply.
    cc = dedupeAddresses([...email.to, ...email.cc]).filter((address) => {
      const key = normalizeEmail(address.email);
      if (ownKeys.has(key)) return false;
      if (toKeys.has(key)) return false;
      return true;
    });
  }

  return { identityId, to, cc };
}

export function replyDraft(email: EmailDetail, identities: Identity[], all: boolean): ComposerDraft {
  const { identityId, to, cc } = replyRecipients(email, identities, all);

  const draft: ComposerDraft = {
    identityId,
    to,
    cc,
    bcc: [],
    subject: deriveSubject(email.subject),
    bodyHtml: quotedBody(email),
    mode: all ? "reply-all" : "reply",
  };

  // RFC 5322 §3.6.4. The two header fields are independently optional, so
  // they are derived separately rather than behind a single guard:
  //
  //   In-Reply-To — the parent's own Message-ID, if it has one.
  //   References  — the parent's References (if any) followed by the
  //                 parent's Message-ID (if any). When the parent carries no
  //                 References of its own but does carry an In-Reply-To
  //                 containing *a single* message identifier, that
  //                 In-Reply-To stands in for the missing References. The
  //                 single-identifier qualifier is part of the rule: a
  //                 multi-identifier In-Reply-To does not name one parent, so
  //                 the RFC does not authorize promoting it to References.
  //
  // A parent with References but no Message-ID therefore still yields a
  // References chain — suppressing it would detach the reply from the
  // thread. Each field is omitted entirely (never sent as an empty array)
  // when its rule produces nothing, and when the parent has none of
  // References, In-Reply-To or Message-ID, neither field is emitted.
  //
  // Every inherited value is filtered and the resulting chain trimmed (see
  // keepSendableIds/trimMessageIdChain) so what this builds always satisfies
  // sendEmailSchema — a draft the user cannot send is a worse outcome than
  // slightly shorter ancestry.
  const parentMessageId = keepSendableIds(email.messageId ?? []);
  const parentReferences = keepSendableIds(email.references ?? []);
  // Arity is checked on the parent's In-Reply-To as received, before unusable
  // ids are dropped, so filtering can never turn a multi-identifier field
  // into an eligible single-identifier fallback.
  const rawInReplyTo = email.inReplyTo ?? [];
  const inReplyToFallback = rawInReplyTo.length === 1 ? keepSendableIds(rawInReplyTo) : [];
  const inheritedChain = parentReferences.length > 0 ? parentReferences : inReplyToFallback;
  const references = trimMessageIdChain(dedupeStrings([...inheritedChain, ...parentMessageId]));

  if (parentMessageId.length > 0) draft.inReplyTo = trimMessageIdChain(parentMessageId);
  if (references.length > 0) draft.references = references;

  return draft;
}

// Continues editing an existing draft (Gmail: click a draft row → it opens
// in the composer instead of the read-only reader). Unlike replyDraft/
// forwardDraft, this does not quote/wrap the body — the draft's own body is
// the thing being edited, verbatim — and it carries originalDraftId so a
// successful send can trash the stale original (see useComposer.ts).
//
// GH #146: the draft's threading headers are restored as they were stored,
// NOT derived. This is the one caller where derivation would be wrong:
// replyDraft is looking at the *parent* of the message it is composing, so it
// has to build a chain; here the message being reopened is the reply itself,
// and its own In-Reply-To/References already name its parent and ancestry.
// email.messageId is deliberately ignored for the same reason — it is the
// draft's own identifier, so folding it in would make the reply claim to be
// its own parent.
//
// The ids still pass through keepSendableIds/trimMessageIdChain: a draft
// written by another client against the same account can carry a chain that
// sendEmailSchema rejects, and losing an ancestry link beats a reply the user
// cannot send (same trade-off replyDraft documents above).
export function buildEditDraft(email: EmailDetail, identities: Identity[]): ComposerDraft {
  const identity = pickIdentityByFrom(email, identities);
  const rawHtml = email.bodyHtml ?? escapeHtml(email.bodyText ?? "");
  // KNOWN LIMITATION: no cidMap is passed here, so inline cid: images (e.g. an
  // embedded logo/signature image) render broken in the composer editor and
  // are dropped from the resend — sanitizeEmailHtml only rewrites cid: src
  // attributes when handed a resolved cid -> src map (see EmailBody, which
  // resolves those blobs for the read-only reader). forwardDraft's quotedBody
  // has the exact same gap; parity with that existing behavior is accepted
  // here rather than plumbing blob resolution into the draft-edit path.
  const sanitized = sanitizeEmailHtml(rawHtml, { allowRemoteImages: false });

  const draft: ComposerDraft = {
    identityId: identity?.id ?? identities[0]?.id ?? "",
    to: dedupeAddresses(email.to),
    cc: dedupeAddresses(email.cc),
    // KNOWN LIMITATION: EmailDetail (packages/shared/src/api/mail.ts) does not
    // expose bcc — the /threads endpoint never requests it from JMAP (see
    // apps/server/src/modules/mail/router.ts) — so a draft's original bcc
    // recipients cannot be restored here without extending that shared
    // contract, which is out of scope for this change.
    bcc: [],
    subject: email.subject,
    bodyHtml: sanitized.html,
    originalDraftId: email.id,
    mode: "draft",
    attachments: email.attachments.map((attachment) => ({
      blobId: attachment.blobId,
      name: attachment.name?.trim() || "attachment",
      type: attachment.type,
      size: attachment.size,
    })),
  };

  // Each field is independently optional (RFC 5322 §3.6.4) and omitted
  // entirely — never sent as an empty array — when the draft carries none,
  // matching replyDraft and keeping a plain new-mail draft free of threading
  // headers it never had.
  const inReplyTo = trimMessageIdChain(dedupeStrings(keepSendableIds(email.inReplyTo ?? [])));
  const references = trimMessageIdChain(dedupeStrings(keepSendableIds(email.references ?? [])));
  if (inReplyTo.length > 0) draft.inReplyTo = inReplyTo;
  if (references.length > 0) draft.references = references;

  return draft;
}

export function forwardDraft(email: EmailDetail, identities: Identity[]): ComposerDraft {
  const identity = pickIdentity(email, identities);
  return {
    identityId: identity?.id ?? identities[0]?.id ?? "",
    to: [],
    cc: [],
    bcc: [],
    subject: deriveForwardSubject(email.subject),
    bodyHtml: quotedBody(email),
    mode: "forward",
    attachments: email.attachments.map((attachment) => ({
      blobId: attachment.blobId,
      name: attachment.name?.trim() || "attachment",
      type: attachment.type,
      size: attachment.size,
    })),
  };
}
