import { describe, expect, it } from "vitest";
import {
  attachmentMetaSchema,
  customLabelSchema,
  emailDetailSchema,
  emailSummarySchema,
  emailUpdateSchema,
  mailboxSchema,
  threadDetailSchema,
  userPreferencesSchema,
  userPreferencesUpdateSchema,
} from "./mail";

describe("mail contracts", () => {
  it("accepts a valid mailbox", () => {
    const parsed = mailboxSchema.parse({
      id: "mb1",
      name: "Inbox",
      parentId: null,
      role: "inbox",
      sortOrder: 0,
      unreadEmails: 3,
      totalEmails: 10,
    });
    expect(parsed.role).toBe("inbox");
  });

  it("accepts a valid email summary", () => {
    const parsed = emailSummarySchema.parse({
      id: "e1",
      threadId: "t1",
      mailboxIds: ["mb1"],
      from: [{ name: "Ana", email: "ana@noxvytop.com" }],
      to: [{ name: null, email: "b@noxvytop.com" }],
      subject: "Hello",
      receivedAt: "2026-07-06T10:00:00Z",
      preview: "Hi there",
      keywords: { $seen: true },
      hasAttachment: false,
      size: 1234,
    });
    expect(parsed.keywords.$seen).toBe(true);
  });

  it("accepts a thread with html-only and text-only emails", () => {
    const email = {
      id: "e1",
      threadId: "t1",
      mailboxIds: ["mb1"],
      from: [],
      to: [],
      subject: "",
      receivedAt: "2026-07-06T10:00:00Z",
      preview: "",
      keywords: {},
      hasAttachment: true,
      size: 10,
      cc: [],
      replyTo: [],
      bodyHtml: "<p>hi</p>",
      bodyText: null,
      attachments: [{ blobId: "b1", name: "a.pdf", type: "application/pdf", size: 99, cid: null }],
      messageId: ["e1@noxvytop.com"],
      references: null,
      inReplyTo: null,
    };
    const parsed = threadDetailSchema.parse({ id: "t1", emails: [email] });
    expect(parsed.emails[0]?.attachments[0]?.name).toBe("a.pdf");
  });

  it("accepts an attachment with a cid (inline image reference)", () => {
    const parsed = attachmentMetaSchema.parse({
      blobId: "b1",
      name: "logo.png",
      type: "image/png",
      size: 512,
      cid: "logo123",
    });
    expect(parsed.cid).toBe("logo123");
  });

  it("accepts an attachment with a null cid (regular, non-inline attachment)", () => {
    const parsed = attachmentMetaSchema.parse({
      blobId: "b1",
      name: "report.pdf",
      type: "application/pdf",
      size: 512,
      cid: null,
    });
    expect(parsed.cid).toBeNull();
  });

  it("rejects an attachment missing the cid field", () => {
    expect(() =>
      attachmentMetaSchema.parse({
        blobId: "b1",
        name: "a.pdf",
        type: "application/pdf",
        size: 10,
      }),
    ).toThrow();
  });

  it("rejects an empty email update", () => {
    expect(() => emailUpdateSchema.parse({})).toThrow();
    expect(emailUpdateSchema.parse({ keywords: { $seen: true } }).keywords).toEqual({
      $seen: true,
    });
  });
});

describe("emailDetailSchema", () => {
  // GH #120: messageId/references/inReplyTo are the JMAP Email properties
  // that carry this message's own Message-ID, its ancestors' Message-IDs and
  // the id of the message it replied to, used to build RFC 5322 threading
  // headers (In-Reply-To/References) on reply. Per RFC 8621 these carry the
  // parsed form, with angle brackets and CFWS removed.
  const base = {
    id: "e1",
    threadId: "t1",
    mailboxIds: ["mb1"],
    from: [],
    to: [],
    subject: "",
    receivedAt: "2026-07-06T10:00:00Z",
    preview: "",
    keywords: {},
    hasAttachment: false,
    size: 10,
    cc: [],
    replyTo: [],
    bodyHtml: null,
    bodyText: null,
    attachments: [],
  };

  it("accepts populated messageId, references and inReplyTo arrays", () => {
    const parsed = emailDetailSchema.parse({
      ...base,
      messageId: ["msg-1@noxvytop.com"],
      references: ["msg-0@noxvytop.com", "msg-1@noxvytop.com"],
      inReplyTo: ["msg-0@noxvytop.com"],
    });
    expect(parsed.messageId).toEqual(["msg-1@noxvytop.com"]);
    expect(parsed.references).toEqual(["msg-0@noxvytop.com", "msg-1@noxvytop.com"]);
    expect(parsed.inReplyTo).toEqual(["msg-0@noxvytop.com"]);
  });

  it("accepts null messageId, references and inReplyTo — JMAP uses null when the message has no such header", () => {
    const parsed = emailDetailSchema.parse({
      ...base,
      messageId: null,
      references: null,
      inReplyTo: null,
    });
    expect(parsed.messageId).toBeNull();
    expect(parsed.references).toBeNull();
    expect(parsed.inReplyTo).toBeNull();
  });

  // Same reasoning as userPreferences.customLabels below: a response from a
  // server that predates these fields must degrade to "no threading data"
  // rather than throw, because emailDetailSchema is parsed as part of
  // threadDetailSchema — a throw here takes down the whole thread view, not
  // just reply threading.
  it("defaults messageId to null when the field is missing", () => {
    const payload: Record<string, unknown> = { ...base, references: null, inReplyTo: null };
    expect(emailDetailSchema.parse(payload).messageId).toBeNull();
  });

  it("defaults references to null when the field is missing", () => {
    const payload: Record<string, unknown> = { ...base, messageId: null, inReplyTo: null };
    expect(emailDetailSchema.parse(payload).references).toBeNull();
  });

  it("defaults inReplyTo to null when the field is missing", () => {
    const payload: Record<string, unknown> = { ...base, messageId: null, references: null };
    expect(emailDetailSchema.parse(payload).inReplyTo).toBeNull();
  });

  it("parses an email with all three threading fields absent", () => {
    const parsed = emailDetailSchema.parse({ ...base });
    expect(parsed.messageId).toBeNull();
    expect(parsed.references).toBeNull();
    expect(parsed.inReplyTo).toBeNull();
  });
});

describe("customLabelSchema", () => {
  const valid = { slug: "ventas-q3", name: "Ventas Q3", color: "#9B6BDB" };

  it("accepts a valid custom label", () => {
    expect(customLabelSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a slug with uppercase or spaces (must be an ASCII-safe JMAP keyword slug)", () => {
    expect(() => customLabelSchema.parse({ ...valid, slug: "Ventas Q3" })).toThrow();
    expect(() => customLabelSchema.parse({ ...valid, slug: "VENTAS" })).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => customLabelSchema.parse({ ...valid, name: "" })).toThrow();
  });

  it("rejects a color that isn't a 6-digit hex", () => {
    expect(() => customLabelSchema.parse({ ...valid, color: "violet" })).toThrow();
    expect(() => customLabelSchema.parse({ ...valid, color: "#FFF" })).toThrow();
  });
});

describe("userPreferencesSchema", () => {
  it("defaults customLabels to an empty array when absent (backward compatible)", () => {
    const parsed = userPreferencesSchema.parse({ groupMailInMainInbox: true });
    expect(parsed.customLabels).toEqual([]);
  });

  it("accepts a preferences payload with custom labels", () => {
    const label = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    const parsed = userPreferencesSchema.parse({ groupMailInMainInbox: true, customLabels: [label] });
    expect(parsed.customLabels).toEqual([label]);
  });

  it("rejects duplicate slugs (case-insensitive) within customLabels", () => {
    const a = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    const b = { slug: "VENTAS", name: "Ventas otra vez", color: "#E8639C" };
    expect(() =>
      userPreferencesSchema.parse({ groupMailInMainInbox: true, customLabels: [a, b] }),
    ).toThrow();
  });
});

describe("userPreferencesUpdateSchema", () => {
  it("accepts a patch with only customLabels", () => {
    const label = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    const parsed = userPreferencesUpdateSchema.parse({ customLabels: [label] });
    expect(parsed.customLabels).toEqual([label]);
  });

  it("leaves customLabels undefined when omitted (merge patch semantics)", () => {
    const parsed = userPreferencesUpdateSchema.parse({ groupMailInMainInbox: false });
    expect(parsed.customLabels).toBeUndefined();
  });

  it("rejects duplicate slugs within a customLabels patch", () => {
    const a = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    const b = { slug: "ventas", name: "Otra", color: "#E8639C" };
    expect(() => userPreferencesUpdateSchema.parse({ customLabels: [a, b] })).toThrow();
  });
});
