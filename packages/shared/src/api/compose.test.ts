import { describe, expect, it } from "vitest";
import {
  identitySchema,
  signatureSchema,
  signatureInputSchema,
  blobUploadResultSchema,
  sendEmailSchema,
} from "./compose";

describe("identitySchema", () => {
  it("parses a valid identity", () => {
    const result = identitySchema.parse({
      id: "id-1",
      name: "Carlos",
      email: "carlos@noxvytop.com",
    });
    expect(result).toEqual({
      id: "id-1",
      name: "Carlos",
      email: "carlos@noxvytop.com",
    });
  });
});

describe("signatureSchema", () => {
  it("parses a valid signature", () => {
    const result = signatureSchema.parse({
      id: "sig-1",
      name: "Default",
      contentHtml: "<p>Regards</p>",
      isDefault: true,
    });
    expect(result).toEqual({
      id: "sig-1",
      name: "Default",
      contentHtml: "<p>Regards</p>",
      isDefault: true,
    });
  });
});

describe("signatureInputSchema", () => {
  it("defaults isDefault to false when omitted", () => {
    const result = signatureInputSchema.parse({
      name: "Default",
      contentHtml: "<p>Regards</p>",
    });
    expect(result.isDefault).toBe(false);
  });
});

describe("blobUploadResultSchema", () => {
  it("parses a valid blob upload result", () => {
    const result = blobUploadResultSchema.parse({
      blobId: "blob-1",
      type: "image/png",
      size: 1024,
    });
    expect(result).toEqual({
      blobId: "blob-1",
      type: "image/png",
      size: 1024,
    });
  });
});

describe("sendEmailSchema", () => {
  it("rejects zero recipients", () => {
    const result = sendEmailSchema.safeParse({
      identityId: "id-1",
      textBody: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("accepts bcc-only recipients", () => {
    const result = sendEmailSchema.safeParse({
      identityId: "id-1",
      bcc: [{ name: null, email: "hidden@noxvytop.com" }],
      textBody: "hello",
    });
    expect(result.success).toBe(true);
  });

  // GH #120: inReplyTo/references originate from an arbitrary remote sender
  // and are written verbatim into an outgoing message's headers, so they are
  // bounded here — see the limits documented in compose.ts.
  describe("threading header bounds", () => {
    function withThreading(fields: { inReplyTo?: string[]; references?: string[] }) {
      return sendEmailSchema.safeParse({
        identityId: "id-1",
        to: [{ name: null, email: "bob@noxvytop.com" }],
        textBody: "hello",
        ...fields,
      });
    }

    it("accepts a message id exactly at the per-id length limit", () => {
      expect(withThreading({ inReplyTo: ["a".repeat(998)] }).success).toBe(true);
      expect(withThreading({ references: ["a".repeat(998)] }).success).toBe(true);
    });

    it("rejects a message id one character over the per-id length limit", () => {
      expect(withThreading({ inReplyTo: ["a".repeat(999)] }).success).toBe(false);
      expect(withThreading({ references: ["a".repeat(999)] }).success).toBe(false);
    });

    it("accepts a chain exactly at the entry-count limit", () => {
      const chain = Array.from({ length: 256 }, (_, i) => `m-${i}@noxvytop.com`);
      expect(withThreading({ inReplyTo: chain }).success).toBe(true);
      expect(withThreading({ references: chain }).success).toBe(true);
    });

    it("rejects a chain one entry over the entry-count limit", () => {
      const chain = Array.from({ length: 257 }, (_, i) => `m-${i}@noxvytop.com`);
      expect(withThreading({ inReplyTo: chain }).success).toBe(false);
      expect(withThreading({ references: chain }).success).toBe(false);
    });

    it("still accepts a realistic reply chain", () => {
      const result = withThreading({
        inReplyTo: ["msg-1@noxvytop.com"],
        references: ["msg-0@noxvytop.com", "msg-1@noxvytop.com"],
      });
      expect(result.success).toBe(true);
    });

    // Built from char codes so the dangerous characters survive any editor or
    // encoding round-trip verbatim.
    const CR = String.fromCharCode(0x0d);
    const LF = String.fromCharCode(0x0a);
    const NUL = String.fromCharCode(0x00);
    const BEL = String.fromCharCode(0x07);
    const ESC = String.fromCharCode(0x1b);
    const DEL = String.fromCharCode(0x7f);

    it("rejects an empty message id", () => {
      expect(withThreading({ inReplyTo: [""] }).success).toBe(false);
      expect(withThreading({ references: [""] }).success).toBe(false);
    });

    // CR/LF would let a remote sender append arbitrary header fields to the
    // outgoing message and NUL can truncate it — the two concrete dangers a
    // length bound alone does nothing about.
    it("rejects a message id containing CR, LF or NUL", () => {
      for (const injected of [
        `msg-1@noxvytop.com${CR}${LF}Bcc: attacker@evil.test`,
        `msg-1@noxvytop.com${LF}X-Injected: yes`,
        `msg-1@noxvytop.com${NUL}`,
      ]) {
        expect(withThreading({ inReplyTo: [injected] }).success).toBe(false);
        expect(withThreading({ references: [injected] }).success).toBe(false);
      }
    });

    it("rejects any other C0 control character or DEL", () => {
      expect(withThreading({ references: [`msg-1@noxvytop.com${BEL}`] }).success).toBe(false);
      expect(withThreading({ references: [`msg-1@noxvytop.com${ESC}`] }).success).toBe(false);
      expect(withThreading({ references: [`msg-1@noxvytop.com${DEL}`] }).success).toBe(false);
    });

    // Deliberate: real-world senders emit Message-IDs that are not strict
    // RFC 5322 atext. Rejecting those would silently break threading for
    // them, which is a worse failure than carrying a bounded,
    // control-character-free value through. See the rationale in compose.ts.
    it("still accepts a technically non-conformant but harmless message id", () => {
      expect(withThreading({ references: ["not an atext id"] }).success).toBe(true);
      expect(withThreading({ references: ["unicode-ñ@noxvytop.com"] }).success).toBe(true);
      expect(withThreading({ references: ["<already-bracketed@noxvytop.com>"] }).success).toBe(true);
    });
  });
});
