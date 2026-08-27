import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_ID_COUNT,
  MAX_MESSAGE_ID_LENGTH,
  sendEmailSchema,
  type EmailDetail,
  type Identity,
} from "@webmail/shared";
import {
  buildEditDraft,
  emptyDraft,
  replyDraft,
  replyRecipients,
  forwardDraft,
  type ComposerDraft,
} from "./reply";
import { QUOTE_MARKER_ATTR } from "./signature";

const identities: Identity[] = [
  { id: "id1", name: "Alice", email: "alice@example.com" },
  { id: "id2", name: "Zed", email: "zed@example.com" },
];

function makeEmail(overrides: Partial<EmailDetail> = {}): EmailDetail {
  return {
    id: "e1",
    threadId: "t1",
    mailboxIds: ["inbox"],
    from: [{ name: "Bob", email: "Bob@Example.com" }],
    to: [
      { name: "Alice", email: "alice@example.com" },
      { name: "Carol", email: "carol@example.com" },
    ],
    cc: [{ name: "Dave", email: "dave@example.com" }],
    replyTo: [],
    subject: "Meeting notes",
    receivedAt: "2024-01-01T00:00:00Z",
    preview: "preview text",
    keywords: {},
    hasAttachment: false,
    size: 100,
    bodyHtml: '<p>Hello <img src="http://evil.test/track.png"></p>',
    bodyText: null,
    attachments: [],
    messageId: ["parent@example.com"],
    references: null,
    inReplyTo: null,
    senderAuth: "unknown",
    senderTrust: "none",
    bodyTruncated: false,
    ...overrides,
  };
}

describe("emptyDraft", () => {
  it("picks the first identity", () => {
    expect(emptyDraft(identities).identityId).toBe("id1");
  });

  it("falls back to an empty identityId with no identities", () => {
    expect(emptyDraft([]).identityId).toBe("");
  });

  it("returns empty recipients, subject, and body", () => {
    const draft = emptyDraft(identities);
    expect(draft.to).toEqual([]);
    expect(draft.cc).toEqual([]);
    expect(draft.bcc).toEqual([]);
    expect(draft.subject).toBe("");
    expect(draft.bodyHtml).toBe("");
  });
});

describe("replyDraft", () => {
  it("uses replyTo when present, else from", () => {
    const email = makeEmail();
    expect(replyDraft(email, identities, false).to).toEqual(email.from);

    const withReplyTo = makeEmail({ replyTo: [{ name: null, email: "replyto@example.com" }] });
    expect(replyDraft(withReplyTo, identities, false).to).toEqual(withReplyTo.replyTo);
  });

  it("leaves cc empty for a plain reply", () => {
    expect(replyDraft(makeEmail(), identities, false).cc).toEqual([]);
  });

  it("reply-all cc is to ∪ cc minus own identity minus to, deduped by lowercased email", () => {
    const email = makeEmail({
      to: [
        { name: "Alice", email: "alice@example.com" },
        { name: "Carol", email: "carol@example.com" },
        { name: "Carol Dup", email: "CAROL@example.com" },
      ],
      cc: [{ name: "Dave", email: "dave@example.com" }],
    });
    const draft = replyDraft(email, identities, true);
    expect(draft.cc.map((a) => a.email.toLowerCase())).toEqual(["carol@example.com", "dave@example.com"]);
  });

  it("picks the identity matching an original recipient", () => {
    const draft = replyDraft(makeEmail(), identities, false);
    expect(draft.identityId).toBe("id1");
  });

  // GH #186: replying to a message the user sent must not address the reply to
  // the user themselves. The reader's toolbar Reply acts on the newest message
  // in a thread, which in an active thread is often one's own — so hitting
  // Reply there used to open a draft to yourself, with the real correspondent
  // demoted to Cc under reply-all.
  describe("replying to one's own message (GH #186)", () => {
    // from = alice, who is identity id1 — i.e. the user sent this.
    const ownMessage = makeEmail({
      from: [{ name: "Alice", email: "alice@example.com" }],
      to: [{ name: "Carol", email: "carol@example.com" }],
      cc: [{ name: "Dave", email: "dave@example.com" }],
    });

    it("addresses a reply to the original recipients, not to oneself", () => {
      const { to } = replyRecipients(ownMessage, identities, false);
      expect(to.map((a) => a.email.toLowerCase())).toEqual(["carol@example.com"]);
      expect(to.map((a) => a.email.toLowerCase())).not.toContain("alice@example.com");
    });

    it("reply-all keeps the correspondent in To and the rest in Cc, never oneself", () => {
      const { to, cc } = replyRecipients(ownMessage, identities, true);
      expect(to.map((a) => a.email.toLowerCase())).toEqual(["carol@example.com"]);
      expect(cc.map((a) => a.email.toLowerCase())).toEqual(["dave@example.com"]);
      const everyone = [...to, ...cc].map((a) => a.email.toLowerCase());
      expect(everyone).not.toContain("alice@example.com");
    });

    it("honours an explicit Reply-To even on one's own message", () => {
      const withReplyTo = makeEmail({
        from: [{ name: "Alice", email: "alice@example.com" }],
        replyTo: [{ name: null, email: "list@example.com" }],
        to: [{ name: "Carol", email: "carol@example.com" }],
      });
      expect(
        replyRecipients(withReplyTo, identities, false).to.map((a) => a.email.toLowerCase()),
      ).toEqual(["list@example.com"]);
    });

    it("falls back to the sender when the message was sent only to oneself", () => {
      const noteToSelf = makeEmail({
        from: [{ name: "Alice", email: "alice@example.com" }],
        to: [{ name: "Alice", email: "alice@example.com" }],
        cc: [],
      });
      expect(
        replyRecipients(noteToSelf, identities, false).to.map((a) => a.email.toLowerCase()),
      ).toEqual(["alice@example.com"]);
    });
  });

  it("reply-all cc excludes every own identity, not just the picked one", () => {
    // Both alice (id1) and zed (id2) are the user's own addresses. A message
    // sent to both plus Carol must not cc either of the user's own addresses.
    const email = makeEmail({
      from: [{ name: "Bob", email: "bob@example.com" }],
      to: [
        { name: "Alice", email: "alice@example.com" },
        { name: "Zed", email: "zed@example.com" },
        { name: "Carol", email: "carol@example.com" },
      ],
      cc: [],
    });
    const { cc } = replyRecipients(email, identities, true);
    const ccEmails = cc.map((a) => a.email.toLowerCase());
    expect(ccEmails).toContain("carol@example.com");
    expect(ccEmails).not.toContain("alice@example.com");
    expect(ccEmails).not.toContain("zed@example.com");
  });

  it("falls back to the first identity when no recipient matches", () => {
    const email = makeEmail({
      to: [{ name: "Someone", email: "someone-else@example.com" }],
      cc: [],
    });
    expect(replyDraft(email, identities, false).identityId).toBe("id1");
  });

  it("prefixes the subject with a single Re:", () => {
    expect(replyDraft(makeEmail(), identities, false).subject).toBe("Re: Meeting notes");
  });

  it("does not double-prefix an already-Re: subject", () => {
    const email = makeEmail({ subject: "re: Meeting notes" });
    expect(replyDraft(email, identities, false).subject).toBe("re: Meeting notes");
  });

  it("quotes the sanitized original body and strips remote images", () => {
    const draft = replyDraft(makeEmail(), identities, false);
    expect(draft.bodyHtml).toContain("Hello");
    expect(draft.bodyHtml).toContain("<blockquote>");
    expect(draft.bodyHtml).not.toMatch(/src=["']https?:\/\//i);
  });

  it("wraps the quoted block in the marker composer/signature.ts anchors on", () => {
    const draft = replyDraft(makeEmail(), identities, false);
    expect(draft.bodyHtml).toContain(`<div ${QUOTE_MARKER_ATTR}="true">`);
  });

  it("prepends an escaped attribution line with date and sender", () => {
    const draft = replyDraft(makeEmail(), identities, false);
    expect(draft.bodyHtml).toContain("2024-01-01T00:00:00Z");
    expect(draft.bodyHtml).toContain("Bob");
  });

  it("falls back to escaped bodyText when bodyHtml is absent", () => {
    const email = makeEmail({ bodyHtml: null, bodyText: "Plain <script> text" });
    const draft = replyDraft(email, identities, false);
    expect(draft.bodyHtml).toContain("Plain &lt;script&gt; text");
  });

  // GH #120: threading headers per RFC 5322 §3.6.4 — In-Reply-To is the
  // parent's own Message-ID, References is the parent's References followed
  // by the parent's own Message-ID. The two fields are independently
  // optional, so each is asserted on its own below.
  it("sets inReplyTo to the parent's own Message-ID", () => {
    const email = makeEmail({ messageId: ["parent@example.com"], references: null });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toEqual(["parent@example.com"]);
  });

  it("sets references to the parent's references followed by the parent's Message-ID, in that order", () => {
    const email = makeEmail({
      messageId: ["parent@example.com"],
      references: ["grandparent@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.references).toEqual(["grandparent@example.com", "parent@example.com"]);
  });

  it("yields a single-element references chain when the parent has no prior references", () => {
    const email = makeEmail({ messageId: ["parent@example.com"], references: null });
    const draft = replyDraft(email, identities, false);
    expect(draft.references).toEqual(["parent@example.com"]);
  });

  it("omits inReplyTo but still emits references when the parent has no Message-ID of its own", () => {
    const email = makeEmail({ messageId: null, references: ["grandparent@example.com"] });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toEqual(["grandparent@example.com"]);
  });

  it("also omits inReplyTo (not an empty array) when the parent's messageId is an empty array", () => {
    const email = makeEmail({ messageId: [], references: ["grandparent@example.com"] });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toEqual(["grandparent@example.com"]);
  });

  // RFC 5322 §3.6.4, second clause: a parent with no References of its own
  // but with an In-Reply-To containing *a single* message identifier
  // contributes that In-Reply-To in place of the missing References. The
  // single-identifier qualifier is part of the rule, so both arities are
  // asserted.
  it("falls back to the parent's In-Reply-To when it holds a single identifier and the parent has no references", () => {
    const email = makeEmail({
      messageId: ["parent@example.com"],
      references: null,
      inReplyTo: ["grandparent@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.references).toEqual(["grandparent@example.com", "parent@example.com"]);
  });

  it("does not fall back to the parent's In-Reply-To when it holds more than one identifier", () => {
    const email = makeEmail({
      messageId: ["parent@example.com"],
      references: null,
      inReplyTo: ["a@example.com", "b@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.references).toEqual(["parent@example.com"]);
  });

  it("emits no references at all when a multi-identifier In-Reply-To is the parent's only threading header", () => {
    const email = makeEmail({
      messageId: null,
      references: null,
      inReplyTo: ["a@example.com", "b@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
  });

  it("prefers the parent's references over its In-Reply-To when both are present", () => {
    const email = makeEmail({
      messageId: ["parent@example.com"],
      references: ["grandparent@example.com"],
      inReplyTo: ["ignored@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.references).toEqual(["grandparent@example.com", "parent@example.com"]);
  });

  it("emits references from the parent's In-Reply-To alone when the parent has neither references nor a Message-ID", () => {
    const email = makeEmail({
      messageId: null,
      references: null,
      inReplyTo: ["grandparent@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toEqual(["grandparent@example.com"]);
  });

  it("omits both fields when the parent has none of references, In-Reply-To, or Message-ID", () => {
    const email = makeEmail({ messageId: null, references: null, inReplyTo: null });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
  });

  it("omits both fields when all three parent header arrays are empty", () => {
    const email = makeEmail({ messageId: [], references: [], inReplyTo: [] });
    const draft = replyDraft(email, identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
  });

  // Discriminating input: first-seen dedupe yields [b, a], last-seen yields
  // [a, b]. Only first-seen preserves the documented ancestry order.
  it("dedupes repeated ids in the references chain while preserving first-seen order", () => {
    const email = makeEmail({
      messageId: ["b@example.com"],
      references: ["b@example.com", "a@example.com"],
    });
    const draft = replyDraft(email, identities, false);
    expect(draft.references).toEqual(["b@example.com", "a@example.com"]);
  });

  it("reply-all produces the same threading headers as a plain reply", () => {
    const email = makeEmail({
      messageId: ["parent@example.com"],
      references: ["grandparent@example.com"],
    });
    const replyOnly = replyDraft(email, identities, false);
    const replyAll = replyDraft(email, identities, true);
    expect(replyAll.inReplyTo).toEqual(replyOnly.inReplyTo);
    expect(replyAll.references).toEqual(replyOnly.references);
  });

  // GH #120 regression guard. replyDraft inherits the parent's chain, so a
  // long-lived thread (or a hostile sender) can hand it more ids — or longer
  // ids — than sendEmailSchema accepts. Without trimming here the draft only
  // fails at send time, client-side in composer/api.ts, as an opaque generic
  // error after the user has already written the whole reply.
  describe("threading header trimming", () => {
    const CRLF = String.fromCharCode(0x0d) + String.fromCharCode(0x0a);

    function chainOf(length: number, prefix = "m"): string[] {
      return Array.from({ length }, (_, i) => `${prefix}-${i}@example.com`);
    }

    // Mirrors the payload useComposer.send() builds from a draft, so this
    // asserts the real end-to-end path into sendEmailSchema.
    function sendPayload(draft: ComposerDraft) {
      return {
        identityId: draft.identityId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        textBody: "reply body",
        htmlBody: draft.bodyHtml,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
      };
    }

    it("trims an over-long inherited chain to the entry-count limit", () => {
      const email = makeEmail({
        messageId: ["parent@example.com"],
        references: chainOf(MAX_MESSAGE_ID_COUNT + 50),
      });
      const draft = replyDraft(email, identities, false);
      expect(draft.references).toHaveLength(MAX_MESSAGE_ID_COUNT);
    });

    it("keeps the thread anchor and the most recent ids, dropping the middle", () => {
      const email = makeEmail({
        messageId: ["parent@example.com"],
        references: chainOf(MAX_MESSAGE_ID_COUNT + 50),
      });
      const draft = replyDraft(email, identities, false);
      expect(draft.references?.[0]).toBe("m-0@example.com");
      expect(draft.references?.at(-1)).toBe("parent@example.com");
      expect(draft.references?.at(-2)).toBe(`m-${MAX_MESSAGE_ID_COUNT + 49}@example.com`);
      expect(draft.references).not.toContain("m-1@example.com");
    });

    it("produces a draft that validates against sendEmailSchema instead of throwing", () => {
      const email = makeEmail({
        messageId: ["parent@example.com"],
        references: chainOf(MAX_MESSAGE_ID_COUNT + 50),
      });
      const draft = replyDraft(email, identities, false);
      expect(sendEmailSchema.safeParse(sendPayload(draft)).success).toBe(true);
    });

    it("leaves a chain at or under the limit untouched", () => {
      const references = chainOf(MAX_MESSAGE_ID_COUNT - 1);
      const email = makeEmail({ messageId: ["parent@example.com"], references });
      const draft = replyDraft(email, identities, false);
      expect(draft.references).toEqual([...references, "parent@example.com"]);
    });

    it("drops a single over-long inherited id rather than losing the whole send", () => {
      const email = makeEmail({
        messageId: ["parent@example.com"],
        references: ["grandparent@example.com", "x".repeat(MAX_MESSAGE_ID_LENGTH + 1)],
      });
      const draft = replyDraft(email, identities, false);
      expect(draft.references).toEqual(["grandparent@example.com", "parent@example.com"]);
      expect(sendEmailSchema.safeParse(sendPayload(draft)).success).toBe(true);
    });

    it("drops an inherited id carrying a header-injecting control character", () => {
      const email = makeEmail({
        messageId: ["parent@example.com"],
        references: ["grandparent@example.com", `evil@example.com${CRLF}Bcc: attacker@evil.test`],
      });
      const draft = replyDraft(email, identities, false);
      expect(draft.references).toEqual(["grandparent@example.com", "parent@example.com"]);
    });

    it("drops an unusable parent Message-ID from both fields instead of failing the send", () => {
      const email = makeEmail({
        messageId: ["y".repeat(MAX_MESSAGE_ID_LENGTH + 1)],
        references: ["grandparent@example.com"],
      });
      const draft = replyDraft(email, identities, false);
      expect(draft.inReplyTo).toBeUndefined();
      expect(draft.references).toEqual(["grandparent@example.com"]);
      expect(sendEmailSchema.safeParse(sendPayload(draft)).success).toBe(true);
    });

    it("drops an unusable In-Reply-To fallback id instead of failing the send", () => {
      const email = makeEmail({
        messageId: ["parent@example.com"],
        references: null,
        inReplyTo: ["z".repeat(MAX_MESSAGE_ID_LENGTH + 1)],
      });
      const draft = replyDraft(email, identities, false);
      expect(draft.references).toEqual(["parent@example.com"]);
      expect(sendEmailSchema.safeParse(sendPayload(draft)).success).toBe(true);
    });
  });
});

describe("forwardDraft", () => {
  it("prefixes the subject with a single Fwd:", () => {
    expect(forwardDraft(makeEmail(), identities).subject).toBe("Fwd: Meeting notes");
  });

  it("does not double-prefix an already-Fwd: subject", () => {
    const email = makeEmail({ subject: "FWD: Meeting notes" });
    expect(forwardDraft(email, identities).subject).toBe("FWD: Meeting notes");
  });

  it("starts with no recipients", () => {
    const draft = forwardDraft(makeEmail(), identities);
    expect(draft.to).toEqual([]);
    expect(draft.cc).toEqual([]);
    expect(draft.bcc).toEqual([]);
  });

  it("quotes the sanitized original body with attribution", () => {
    const draft = forwardDraft(makeEmail(), identities);
    expect(draft.bodyHtml).toContain("Hello");
    expect(draft.bodyHtml).toContain("<blockquote>");
    expect(draft.bodyHtml).toContain("2024-01-01T00:00:00Z");
    expect(draft.bodyHtml).toContain("Bob");
    expect(draft.bodyHtml).not.toMatch(/src=["']https?:\/\//i);
  });

  it("wraps the quoted block in the marker composer/signature.ts anchors on", () => {
    const draft = forwardDraft(makeEmail(), identities);
    expect(draft.bodyHtml).toContain(`<div ${QUOTE_MARKER_ATTR}="true">`);
  });

  it("reuses the original attachments by blobId with a name fallback", () => {
    const email = makeEmail({
      attachments: [
        { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048, cid: null },
        { blobId: "b2", name: null, type: "image/png", size: 512, cid: null },
        { blobId: "b3", name: "  ", type: "text/plain", size: 10, cid: null },
      ],
    });
    const draft = forwardDraft(email, identities);
    expect(draft.attachments).toEqual([
      { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048 },
      { blobId: "b2", name: "attachment", type: "image/png", size: 512 },
      { blobId: "b3", name: "attachment", type: "text/plain", size: 10 },
    ]);
  });

  it("picks the identity that received the original", () => {
    expect(forwardDraft(makeEmail(), identities).identityId).toBe("id1");
  });

  // GH #120: a forward starts a new conversation, not a reply — it must not
  // carry the original message's threading headers even though EmailDetail
  // now exposes messageId/references.
  it("does not set inReplyTo or references — a forward starts a new conversation", () => {
    const email = makeEmail({
      messageId: ["parent@example.com"],
      references: ["grandparent@example.com"],
    });
    const draft = forwardDraft(email, identities);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
  });
});

// NEW for feat/v3-edit-draft — kept in its own describe block (separate from
// emptyDraft/replyDraft/forwardDraft above) so it stays a clean, isolated
// diff for review and doesn't interleave with unrelated changes to this file.
describe("buildEditDraft", () => {
  it("keeps the subject exactly as saved, with no Re:/Fwd: prefixing", () => {
    const draft = buildEditDraft(makeEmail({ subject: "Draft in progress" }), identities);
    expect(draft.subject).toBe("Draft in progress");
  });

  it("maps to/cc directly from the draft (no reply-all-style filtering)", () => {
    const email = makeEmail({
      to: [{ name: "Carol", email: "carol@example.com" }],
      cc: [{ name: "Dave", email: "dave@example.com" }],
    });
    const draft = buildEditDraft(email, identities);
    expect(draft.to).toEqual([{ name: "Carol", email: "carol@example.com" }]);
    expect(draft.cc).toEqual([{ name: "Dave", email: "dave@example.com" }]);
  });

  it("dedupes to/cc by lowercased email like the other draft builders", () => {
    const email = makeEmail({
      to: [
        { name: "Carol", email: "carol@example.com" },
        { name: "Carol Dup", email: "CAROL@example.com" },
      ],
    });
    const draft = buildEditDraft(email, identities);
    expect(draft.to.map((a) => a.email.toLowerCase())).toEqual(["carol@example.com"]);
  });

  // KNOWN LIMITATION: EmailDetail (packages/shared/src/api/mail.ts) does not
  // currently expose bcc — the /threads endpoint never requests or returns
  // it (see apps/server/src/modules/mail/router.ts). Restoring bcc when
  // reopening a draft would require extending that shared contract, which is
  // out of scope for this change (see Scope in the change description).
  it("maps bcc to an empty array — EmailDetail does not carry bcc data (documented limitation)", () => {
    const draft = buildEditDraft(makeEmail(), identities);
    expect(draft.bcc).toEqual([]);
  });

  it("picks the identity matching the draft's own From address, not to/cc", () => {
    const email = makeEmail({
      from: [{ name: "Zed", email: "zed@example.com" }],
      to: [{ name: "Someone Else", email: "someone-else@example.com" }],
      cc: [],
    });
    expect(buildEditDraft(email, identities).identityId).toBe("id2");
  });

  it("falls back to the first identity when From matches none of our identities", () => {
    const email = makeEmail({ from: [{ name: "Stranger", email: "stranger@example.com" }] });
    expect(buildEditDraft(email, identities).identityId).toBe("id1");
  });

  it("sets originalDraftId to the draft email's id, for delete-on-send", () => {
    const draft = buildEditDraft(makeEmail({ id: "draft-42" }), identities);
    expect(draft.originalDraftId).toBe("draft-42");
  });

  it("uses the raw bodyHtml as-is (no quote wrapper/attribution/blockquote)", () => {
    const email = makeEmail({ bodyHtml: "<p>work in progress</p>" });
    const draft = buildEditDraft(email, identities);
    expect(draft.bodyHtml).toContain("work in progress");
    expect(draft.bodyHtml).not.toContain("<blockquote>");
    expect(draft.bodyHtml).not.toContain(QUOTE_MARKER_ATTR);
  });

  it("sanitizes the body and strips remote image sources, mirroring reply/forward", () => {
    const draft = buildEditDraft(makeEmail(), identities);
    expect(draft.bodyHtml).not.toMatch(/src=["']https?:\/\//i);
  });

  it("falls back to escaped bodyText when bodyHtml is absent", () => {
    const email = makeEmail({ bodyHtml: null, bodyText: "Plain <script> text" });
    const draft = buildEditDraft(email, identities);
    expect(draft.bodyHtml).toContain("Plain &lt;script&gt; text");
  });

  it("reuses the original attachments by blobId with a name fallback, like forwardDraft", () => {
    const email = makeEmail({
      attachments: [
        { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048, cid: null },
        { blobId: "b2", name: null, type: "image/png", size: 512, cid: null },
      ],
    });
    const draft = buildEditDraft(email, identities);
    expect(draft.attachments).toEqual([
      { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048 },
      { blobId: "b2", name: "attachment", type: "image/png", size: 512 },
    ]);
  });

  // GH #146 (was the GH #120 known limitation): a reopened reply draft keeps
  // the thread it belonged to. Unlike replyDraft these headers are restored,
  // not derived — the draft already stores the ones that describe its own
  // position in the thread.
  describe("threading headers (GH #146)", () => {
    it("restores the draft's own inReplyTo and references verbatim", () => {
      const email = makeEmail({
        messageId: ["draft@example.com"],
        references: ["root@example.com", "parent@example.com"],
        inReplyTo: ["parent@example.com"],
      });
      const draft = buildEditDraft(email, identities);
      expect(draft.inReplyTo).toEqual(["parent@example.com"]);
      expect(draft.references).toEqual(["root@example.com", "parent@example.com"]);
    });

    // The draft's Message-ID names the draft itself. Folding it into either
    // header would make the reply claim to be its own parent — the exact
    // misuse the original limitation was written to avoid.
    it("never folds the draft's own messageId into the restored headers", () => {
      const email = makeEmail({
        messageId: ["draft@example.com"],
        references: ["parent@example.com"],
        inReplyTo: ["parent@example.com"],
      });
      const draft = buildEditDraft(email, identities);
      expect(draft.inReplyTo).not.toContain("draft@example.com");
      expect(draft.references).not.toContain("draft@example.com");
    });

    it("leaves both headers unset for a draft that was never a reply", () => {
      const email = makeEmail({
        messageId: ["draft@example.com"],
        references: null,
        inReplyTo: null,
      });
      const draft = buildEditDraft(email, identities);
      expect(draft.inReplyTo).toBeUndefined();
      expect(draft.references).toBeUndefined();
    });

    it("restores one header when the draft carries only that one", () => {
      const email = buildEditDraft(
        makeEmail({ messageId: null, references: null, inReplyTo: ["parent@example.com"] }),
        identities,
      );
      expect(email.inReplyTo).toEqual(["parent@example.com"]);
      expect(email.references).toBeUndefined();
    });

    // A draft written by another client against the same account is the only
    // way to reach this builder, so its stored chain is untrusted input.
    it("drops unsendable ids instead of losing the whole send", () => {
      const email = makeEmail({
        references: ["parent@example.com", "x".repeat(MAX_MESSAGE_ID_LENGTH + 1)],
        inReplyTo: ["parent@example.com"],
      });
      const draft = buildEditDraft(email, identities);
      expect(draft.references).toEqual(["parent@example.com"]);
    });

    it("trims an over-long stored chain to the entry-count limit, keeping anchor and tail", () => {
      const references = Array.from(
        { length: MAX_MESSAGE_ID_COUNT + 50 },
        (_, i) => `m-${i}@example.com`,
      );
      const draft = buildEditDraft(makeEmail({ references }), identities);
      expect(draft.references).toHaveLength(MAX_MESSAGE_ID_COUNT);
      expect(draft.references?.[0]).toBe("m-0@example.com");
      expect(draft.references?.at(-1)).toBe(`m-${MAX_MESSAGE_ID_COUNT + 49}@example.com`);
      expect(
        sendEmailSchema.safeParse({
          identityId: draft.identityId,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          textBody: "body",
          htmlBody: draft.bodyHtml,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
        }).success,
      ).toBe(true);
    });
  });
});

// GH #140, second half: a truncated body used to be quoted verbatim, so the
// cut silently became part of the thread record from that reply onward.
describe("quoting a truncated original (GH #140)", () => {
  it("marks the quote as elided when the original body was truncated", () => {
    const draft = replyDraft(makeEmail({ bodyTruncated: true }), identities, false);
    expect(draft.bodyHtml).toContain("[&hellip;]");
  });

  it("adds no marker when the original was complete", () => {
    const draft = replyDraft(makeEmail({ bodyTruncated: false }), identities, false);
    expect(draft.bodyHtml).not.toContain("[&hellip;]");
  });

  it("places the marker inside the quote, after the quoted content", () => {
    const draft = replyDraft(makeEmail({ bodyTruncated: true }), identities, false);
    expect(draft.bodyHtml.indexOf("Hello")).toBeLessThan(draft.bodyHtml.indexOf("[&hellip;]"));
    expect(draft.bodyHtml.indexOf("[&hellip;]")).toBeLessThan(draft.bodyHtml.indexOf("</blockquote>"));
  });

  it("marks a forwarded truncated original too — it quotes the same body", () => {
    expect(forwardDraft(makeEmail({ bodyTruncated: true }), identities).bodyHtml).toContain("[&hellip;]");
  });
});
