import { describe, expect, it } from "vitest";
import {
  attachmentMetaSchema,
  emailSummarySchema,
  emailUpdateSchema,
  mailboxSchema,
  threadDetailSchema,
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
