import { describe, expect, it } from "vitest";
import type { EmailDetail, Identity } from "@webmail/shared";
import { buildEditDraft, emptyDraft, replyDraft, forwardDraft } from "./reply";
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

  it("leaves inReplyTo and references undefined for F1", () => {
    const draft = replyDraft(makeEmail(), identities, false);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
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
});
