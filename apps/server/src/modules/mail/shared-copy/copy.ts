import type { JmapAuth, JmapClient, JmapSession } from "../../../infra/jmap/client";

/**
 * Why the G-2 copy failed. Each reason maps onto the status the manual route
 * (`POST /messages/:id/copy-to-inbox`) always answered with, so the route stays
 * a thin adapter over this function and the two never disagree about what a
 * given failure means.
 */
export type CopyFailureReason =
  | "invalid_account"
  | "mailbox_roles_missing"
  | "not_found"
  | "copy_failed";

export type CopyResult =
  | { ok: true; createdId: string }
  | { ok: false; reason: CopyFailureReason };

/**
 * GH #13/#50 (G-2, spike G-0) → GH #313: copies ONE message from a SHARED
 * mailbox into the member's OWN personal Inbox with a single JMAP Email/copy
 * authenticated as the member. Stalwart exposes the shared account in the
 * member's session (G-1 access), so one cross-account copy — fromAccountId =
 * shared, accountId = personal — is all it takes; there is no delegated/group
 * credential (the spike confirmed a group principal cannot even log in).
 *
 * Extracted from the route for GH #313 so the automatic delivery (see
 * ./delivery.ts) issues EXACTLY the same two batches the manual button does,
 * with each opted-in member's own auth + session. Two implementations of the
 * same copy would drift — one carrying keywords, the other not; one confirming
 * positively, the other trusting an empty `notCreated` — and the member would
 * see the difference as "manual copies keep my flags, automatic ones do not".
 *
 * The original is left in place (onSuccessDestroyOriginal:false); the source
 * email's own keywords are carried into the create so flags survive (spike
 * caveat). A caller that ALREADY knows the member's inbox id and the source
 * keywords passes both and the lookup batch is skipped entirely — that is the
 * delivery cycle, which resolves the inbox once per member per cycle and reads
 * the keywords with the page it already fetches; the manual route knows
 * neither and keeps the lookup.
 *
 * The copy counts against the member's personal quota — a documented spike
 * caveat with nothing to do about it, so this makes no attempt to.
 *
 * Never throws for a JMAP-level *answer* (a missing inbox, a missing message,
 * a refused copy): those are the `ok: false` reasons. A transport or auth
 * failure raised by the JMAP client (`stalwart_unavailable`, `mail_auth_failed`,
 * a whole-batch method error) still propagates, because the caller decides
 * what a dead provider means for it — the route lets it reach `app.onError`,
 * the delivery cycle counts it as a failed copy and moves on.
 */
export async function copyEmailToPersonalInbox(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  fromAccountId: string;
  emailId: string;
  /**
   * The member's personal Inbox id, when the caller already knows it. The
   * delivery cycle resolves it ONCE per member per cycle instead of once per
   * message (GH #313); the manual route knows nothing about it and omits it.
   */
  personalInboxId?: string;
  /**
   * The source message's keywords, when the caller already read them — the
   * cycle's page `Email/get` fetches them alongside `mailboxIds`, which it
   * needs anyway to tell inbox mail apart.
   */
  keywords?: Record<string, boolean>;
}): Promise<CopyResult> {
  const { jmap, auth, session, fromAccountId, emailId } = input;
  const personalAccountId = session.accountId;

  // It MUST be a shared, non-personal account: Stalwart rejects a same-account
  // copy with invalidArguments "From accountId is equal to fromAccountId"
  // (spike G-0), so a personal source is refused up front with a clean reason
  // rather than forwarded into an opaque JMAP error.
  if (fromAccountId === personalAccountId) {
    return { ok: false, reason: "invalid_account" };
  }

  // Both answers already in hand — the delivery cycle's case — is the whole
  // lookup batch skipped: it exists to learn exactly these two things, and
  // paying a round trip per (member, message) to re-learn what the cycle read
  // once is the difference between one Email/copy and three calls per copy.
  // BOTH are required to skip it: a caller holding only one of the two still
  // has to ask, and asking for one while assuming the other would make the
  // manual and automatic copies disagree about a message that moved.
  let personalInboxId = input.personalInboxId;
  let keywords = input.keywords;
  if (personalInboxId === undefined || keywords === undefined) {
    // One request resolves the member's personal Inbox (role=inbox on their OWN
    // account) and, alongside it, the source email's keywords so the copy
    // preserves its flags. The Email/get is scoped to the shared account, where
    // the message lives; the Mailbox/query to the personal one, where it lands.
    // Both reach through the member's own credential.
    //
    // Kept as its own batch, apart from the Email/copy below: JmapClient.request
    // fails the WHOLE batch on any method error and retries a batch only when it
    // mutates nothing, so a read folded in with the copy would either lose the
    // retry or risk re-running the copy.
    const lookup = await jmap.request(auth, session, [
      ["Mailbox/query", { accountId: personalAccountId, filter: { role: "inbox" } }, "mbx"],
      ["Email/get", { accountId: fromAccountId, ids: [emailId], properties: ["keywords"] }, "src"],
    ]);

    const inboxResult = (lookup[0]?.[1] ?? {}) as { ids?: string[] };
    personalInboxId = (inboxResult.ids ?? [])[0];
    if (!personalInboxId) {
      return { ok: false, reason: "mailbox_roles_missing" };
    }

    // Email/get is scoped to the shared account, so an id that isn't a message
    // there comes back as an empty list — indistinguishable from "no such
    // message" and refused the same way, never leaking whether the id exists
    // elsewhere.
    const sourceResult = (lookup[1]?.[1] ?? {}) as {
      list?: Array<{ keywords?: Record<string, boolean> }>;
    };
    const source = (sourceResult.list ?? [])[0];
    if (!source) {
      return { ok: false, reason: "not_found" };
    }
    keywords = source.keywords ?? {};
  }

  const responses = await jmap.request(auth, session, [
    [
      "Email/copy",
      {
        fromAccountId,
        accountId: personalAccountId,
        create: {
          c: {
            id: emailId,
            mailboxIds: { [personalInboxId]: true },
            keywords,
          },
        },
        onSuccessDestroyOriginal: false,
      },
      "c",
    ],
  ]);

  const copyResult = (responses[0]?.[1] ?? {}) as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, unknown>;
  };

  // Positive confirmation, matching the destroy/send paths: an empty
  // notCreated is not proof of success. The copy must appear in `created`
  // before this reports it done.
  if (copyResult.notCreated && "c" in copyResult.notCreated) {
    return { ok: false, reason: "copy_failed" };
  }
  const createdId = copyResult.created?.c?.id;
  if (createdId) {
    return { ok: true, createdId };
  }
  return { ok: false, reason: "copy_failed" };
}
