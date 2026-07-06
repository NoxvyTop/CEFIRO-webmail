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
});
