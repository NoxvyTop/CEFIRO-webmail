import { describe, expect, it } from "vitest";
import { blobUrl } from "./blobUrl";

describe("blobUrl", () => {
  it("builds a personal inline URL byte-identical to the old inline builders", () => {
    expect(blobUrl("b1", "photo.png", "image/png")).toBe(
      "/api/mail/blobs/b1?name=photo.png&type=image%2Fpng",
    );
  });

  it("adds &dl=1 for a download", () => {
    expect(blobUrl("b1", "sheet.csv", "text/csv", { download: true })).toBe(
      "/api/mail/blobs/b1?name=sheet.csv&type=text%2Fcsv&dl=1",
    );
  });

  it("appends accountId for a shared mailbox, after dl", () => {
    expect(blobUrl("b1", "sheet.csv", "text/csv", { download: true, accountId: "acc-shared" })).toBe(
      "/api/mail/blobs/b1?name=sheet.csv&type=text%2Fcsv&dl=1&accountId=acc-shared",
    );
    expect(blobUrl("b1", "photo.png", "image/png", { accountId: "acc-shared" })).toBe(
      "/api/mail/blobs/b1?name=photo.png&type=image%2Fpng&accountId=acc-shared",
    );
  });

  it("encodes a null name as an empty name param (inline image fetch)", () => {
    expect(blobUrl("b1", null, "image/gif")).toBe("/api/mail/blobs/b1?name=&type=image%2Fgif");
  });
});
