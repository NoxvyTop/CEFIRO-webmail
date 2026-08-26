import { log } from "../../core/logger";
import type { ContactsRepo, HarvestedContact } from "../../infra/repos/contacts";
import type { SentRecipientsRepo } from "../../infra/repos/sent-recipients";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/jmap/client";

// How many of the most recent messages to inspect when mail arrives (GH #180).
// The harvest triggers on the JMAP Email state advancing, which says mail
// changed but not what — so we pull the newest page and let extraction pick out
// the eligible senders. A delivery is usually one or a few messages; this ceiling
// simply bounds the read if many land between two state changes.
const RECENT_MAIL_HARVEST_LIMIT = 50;

export type HarvestEmail = {
  from?: { name?: string | null; email: string }[];
  mailboxIds?: Record<string, boolean>;
  // GH #314: the recipient lists, requested alongside `from` so the same
  // arrival page can feed the sent-recipients store (see extractSentRecipients).
  // Optional because the sender harvest never needed them and its fixtures
  // omit them.
  to?: { name?: string | null; email: string }[];
  cc?: { name?: string | null; email: string }[];
  bcc?: { name?: string | null; email: string }[];
};

type HarvestMailbox = { id: string; role?: string | null };

// GH #124: this app never sees inbound mail directly (Stalwart delivers it,
// this server only proxies JMAP), so GET /api/mail/messages — the one place
// the server ever observes a batch of received messages — is where contacts
// get harvested from senders. Mail a user marked/received as spam, or
// already threw away, must never seed the address book automatically: an
// autocomplete full of spam senders is worse than no autocomplete at all.
const EXCLUDED_ROLES = new Set(["junk", "trash"]);

/**
 * Pure extraction step, deliberately free of I/O so it's trivial to unit
 * test in isolation (see contacts-harvest.test.ts): given the page of
 * messages GET /messages just fetched and the account's mailbox roles,
 * returns the distinct sender addresses eligible for auto-adding to the
 * user's contacts. Drops mail sitting in Junk/Trash (checked against ALL of
 * a message's mailboxIds, not just the one the page was queried for — a
 * message can be filed in more than one mailbox at once), the owner's own
 * address, and anything without a usable From address. When the same address
 * appears more than once on the page, the first name seen wins.
 */
export function extractHarvestCandidates(
  emails: HarvestEmail[],
  mailboxes: HarvestMailbox[],
  ownerEmail: string,
): HarvestedContact[] {
  const excludedMailboxIds = new Set(
    mailboxes.filter((m) => m.role && EXCLUDED_ROLES.has(m.role)).map((m) => m.id),
  );
  const ownerLower = ownerEmail.toLowerCase();
  const byEmail = new Map<string, string>();

  for (const email of emails) {
    const inExcludedMailbox = Object.keys(email.mailboxIds ?? {}).some((id) =>
      excludedMailboxIds.has(id),
    );
    if (inExcludedMailbox) continue;

    const sender = email.from?.[0];
    if (!sender?.email) continue;
    const lower = sender.email.toLowerCase();
    if (lower === ownerLower) continue;
    if (!byEmail.has(lower)) {
      byEmail.set(lower, sender.name?.trim() || "");
    }
  }

  return [...byEmail.entries()].map(([email, name]) => ({ email, name }));
}

/**
 * GH #314: the sent-mailbox counterpart of extractHarvestCandidates, equally
 * pure. Given the same arrival page and mailbox roles, returns the distinct
 * lowercased to/cc/bcc addresses of the messages sitting in the mailbox with
 * role "sent" — the addresses the user WROTE TO, which is what makes a sender
 * "known" (Tier A). Only Sent counts: a received message's recipients are
 * who else its sender wrote to, not who the user knows, and using them would
 * let a sender make any address "known" by CC-ing it. The owner's own
 * addresses are dropped (a note-to-self is not a correspondent) and an
 * account without a Sent role yields nothing rather than guessing.
 */
export function extractSentRecipients(
  emails: HarvestEmail[],
  mailboxes: HarvestMailbox[],
  ownerEmails: string[],
): Set<string> {
  const sentMailboxId = mailboxes.find((m) => m.role === "sent")?.id;
  const recipients = new Set<string>();
  if (!sentMailboxId) return recipients;
  const owners = new Set(ownerEmails.map((email) => email.toLowerCase()));

  for (const email of emails) {
    if (email.mailboxIds?.[sentMailboxId] !== true) continue;
    for (const entry of [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])]) {
      if (!entry?.email) continue;
      const lower = entry.email.toLowerCase();
      if (owners.has(lower)) continue;
      recipients.add(lower);
    }
  }
  return recipients;
}

/**
 * Resolves the account's `{id, role}` mailbox list in its OWN JMAP round trip
 * — deliberately kept separate from the Email/query + Email/get call that
 * produced the arrival page, because JmapClient.request() throws for the whole
 * batch if ANY call in it comes back as a JMAP-level error. Folding the role
 * lookup into the same batch would mean a harvest-only failure could take the
 * caller's own work down with it, which is exactly what this must never do.
 *
 * GH #314 (JD-4): called ONCE per arrival by harvestOnMailArrival and handed to
 * both harvests below. Each used to make this call for itself, so a delivery
 * with both stores wired asked JMAP twice for the same answer — an answer that
 * cannot have changed between the two calls. Throws on failure; the callers
 * decide what a failed lookup means for them.
 */
async function lookupMailboxRoles(
  jmap: JmapClient,
  auth: JmapAuth,
  session: JmapSession,
): Promise<HarvestMailbox[]> {
  const responses = await jmap.request(auth, session, [
    ["Mailbox/get", { accountId: session.accountId, properties: ["id", "role"] }, "mb"],
  ]);
  return ((responses[0]?.[1] ?? {}) as { list?: HarvestMailbox[] }).list ?? [];
}

/**
 * Best-effort contact harvest from an already-fetched page of messages and an
 * already-resolved mailbox role list. Never throws: a failure here (DB hiccup,
 * anything) is logged and swallowed so the caller is unaffected.
 *
 * Invoked once per delivery from harvestOnMailArrival (GH #180), not on every
 * mail read as it originally was (GH #124).
 */
export async function harvestContacts(input: {
  contacts: ContactsRepo;
  mailboxes: HarvestMailbox[];
  userId: string;
  ownerEmail: string;
  emails: HarvestEmail[];
}): Promise<void> {
  try {
    const candidates = extractHarvestCandidates(input.emails, input.mailboxes, input.ownerEmail);
    if (candidates.length === 0) return;
    await input.contacts.harvestSenders(input.userId, candidates);
  } catch (error) {
    log("warn", "contacts harvest failed", { userId: input.userId, error: String(error) });
  }
}

/**
 * GH #314: best-effort sent-recipient harvest from the same arrival page and
 * the same mailbox role list. Swallows its own failures for the same reason
 * harvestContacts does — a failure in either harvest must not take the other,
 * or the caller's stream, down with it.
 */
export async function harvestSentRecipients(input: {
  sentRecipients: SentRecipientsRepo;
  mailboxes: HarvestMailbox[];
  userId: string;
  ownerEmail: string;
  emails: HarvestEmail[];
}): Promise<void> {
  try {
    const recipients = extractSentRecipients(input.emails, input.mailboxes, [input.ownerEmail]);
    if (recipients.size === 0) return;
    await input.sentRecipients.record(input.userId, [...recipients]);
  } catch (error) {
    log("warn", "sent recipients harvest failed", { userId: input.userId, error: String(error) });
  }
}

/**
 * The "mail arrived" harvest trigger (GH #180). Reading a mailbox is the app's
 * most frequent operation, so harvesting on GET /messages re-harvested the same
 * senders on every page, refetch and return to the inbox. The correct signal is
 * the JMAP Email state advancing on the subscription that feeds the SSE stream —
 * it fires once when mail actually arrives.
 *
 * The state-change event says mail changed but not what, so this pulls the
 * newest page and hands it to harvestContacts. Never throws: a failure fetching
 * that page is logged and swallowed, and harvestContacts swallows the rest, so a
 * harvest hiccup can never disturb the caller's event stream.
 *
 * GH #314: the same page — fetched ONCE — also feeds harvestSentRecipients when
 * a sent-recipients store is wired. Either store may be absent (both are
 * optional in MailDeps); the sender harvest runs exactly as before whether or
 * not the other is present, and the page's `to`/`cc`/`bcc` properties are
 * requested unconditionally so the two paths never diverge in what they read.
 *
 * GH #314 (JD-4): the mailbox role lookup is likewise made ONCE, here, and
 * handed to both. It is skipped entirely when neither store is wired, so an
 * arrival that has nothing to harvest still costs no round trip at all.
 */
export async function harvestOnMailArrival(input: {
  contacts?: ContactsRepo;
  sentRecipients?: SentRecipientsRepo;
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  userId: string;
  ownerEmail: string;
}): Promise<void> {
  try {
    const responses = await input.jmap.request(input.auth, input.session, [
      [
        "Email/query",
        {
          accountId: input.session.accountId,
          sort: [{ property: "receivedAt", isAscending: false }],
          position: 0,
          limit: RECENT_MAIL_HARVEST_LIMIT,
          calculateTotal: false,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: input.session.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["id", "from", "mailboxIds", "to", "cc", "bcc"],
        },
        "g",
      ],
    ]);
    const emails = ((responses[1]?.[1] ?? {}) as { list?: HarvestEmail[] }).list ?? [];
    if (emails.length === 0) return;
    if (!input.contacts && !input.sentRecipients) return;

    const mailboxes = await lookupMailboxRoles(input.jmap, input.auth, input.session);
    if (input.contacts) {
      await harvestContacts({
        contacts: input.contacts,
        mailboxes,
        userId: input.userId,
        ownerEmail: input.ownerEmail,
        emails,
      });
    }
    if (input.sentRecipients) {
      await harvestSentRecipients({
        sentRecipients: input.sentRecipients,
        mailboxes,
        userId: input.userId,
        ownerEmail: input.ownerEmail,
        emails,
      });
    }
  } catch (error) {
    log("warn", "contacts harvest on mail arrival failed", {
      userId: input.userId,
      error: String(error),
    });
  }
}
