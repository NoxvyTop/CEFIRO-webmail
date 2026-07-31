import { log } from "../../core/logger";
import type { ContactsRepo, HarvestedContact } from "../../infra/repos/contacts";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/stalwart/jmap";

// How many of the most recent messages to inspect when mail arrives (GH #180).
// The harvest triggers on the JMAP Email state advancing, which says mail
// changed but not what — so we pull the newest page and let extraction pick out
// the eligible senders. A delivery is usually one or a few messages; this ceiling
// simply bounds the read if many land between two state changes.
const RECENT_MAIL_HARVEST_LIMIT = 50;

export type HarvestEmail = {
  from?: { name?: string | null; email: string }[];
  mailboxIds?: Record<string, boolean>;
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
 * Best-effort contact harvest from an already-fetched page of messages.
 * Resolves mailbox roles with its own JMAP round trip — deliberately kept
 * separate from the Email/query + Email/get call that produced `emails`,
 * because JmapClient.request() throws for the whole batch if ANY call in it
 * comes back as a JMAP-level error. Folding the role lookup into the same
 * batch would mean a harvest-only failure could take the caller's own work
 * down with it, which is exactly what this must never do. Never throws: a
 * failure here (JMAP hiccup, DB hiccup, anything) is logged and swallowed so
 * the caller is unaffected.
 *
 * Invoked once per delivery from harvestOnMailArrival (GH #180), not on every
 * mail read as it originally was (GH #124).
 */
export async function harvestContacts(input: {
  contacts: ContactsRepo;
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  userId: string;
  ownerEmail: string;
  emails: HarvestEmail[];
}): Promise<void> {
  try {
    const responses = await input.jmap.request(input.auth, input.session, [
      ["Mailbox/get", { accountId: input.session.accountId, properties: ["id", "role"] }, "mb"],
    ]);
    const mailboxes = ((responses[0]?.[1] ?? {}) as { list?: HarvestMailbox[] }).list ?? [];
    const candidates = extractHarvestCandidates(input.emails, mailboxes, input.ownerEmail);
    if (candidates.length === 0) return;
    await input.contacts.harvestSenders(input.userId, candidates);
  } catch (error) {
    log("warn", "contacts harvest failed", { userId: input.userId, error: String(error) });
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
 */
export async function harvestOnMailArrival(input: {
  contacts: ContactsRepo;
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
          properties: ["id", "from", "mailboxIds"],
        },
        "g",
      ],
    ]);
    const emails = ((responses[1]?.[1] ?? {}) as { list?: HarvestEmail[] }).list ?? [];
    if (emails.length === 0) return;
    await harvestContacts({
      contacts: input.contacts,
      jmap: input.jmap,
      auth: input.auth,
      session: input.session,
      userId: input.userId,
      ownerEmail: input.ownerEmail,
      emails,
    });
  } catch (error) {
    log("warn", "contacts harvest on mail arrival failed", {
      userId: input.userId,
      error: String(error),
    });
  }
}
