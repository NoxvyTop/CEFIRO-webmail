import { describe, expect, it } from "vitest";
import { extractHarvestCandidates } from "./contacts-harvest";

const mailboxes = [
  { id: "mb-inbox", role: "inbox" },
  { id: "mb-junk", role: "junk" },
  { id: "mb-trash", role: "trash" },
  { id: "mb-custom", role: null },
];

describe("extractHarvestCandidates", () => {
  it("returns the distinct senders of inbox messages", () => {
    const candidates = extractHarvestCandidates(
      [
        { from: [{ name: "Ana", email: "ana@x.com" }], mailboxIds: { "mb-inbox": true } },
        { from: [{ name: "Bob", email: "bob@x.com" }], mailboxIds: { "mb-inbox": true } },
      ],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
      { name: "Ana", email: "ana@x.com" },
      { name: "Bob", email: "bob@x.com" },
    ]);
  });

  it("excludes senders whose message sits in the Junk mailbox", () => {
    const candidates = extractHarvestCandidates(
      [
        { from: [{ name: "Spammer", email: "spam@x.com" }], mailboxIds: { "mb-junk": true } },
        { from: [{ name: "Ana", email: "ana@x.com" }], mailboxIds: { "mb-inbox": true } },
      ],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([{ name: "Ana", email: "ana@x.com" }]);
  });

  it("excludes senders whose message sits in the Trash mailbox", () => {
    const candidates = extractHarvestCandidates(
      [{ from: [{ name: "Deleted", email: "gone@x.com" }], mailboxIds: { "mb-trash": true } }],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([]);
  });

  // A message can sit in more than one mailbox at once (e.g. filed under a
  // custom label as well as Inbox) — membership in Junk/Trash must exclude it
  // even when it is also visible somewhere else.
  it("excludes a message that also sits in Junk even if it sits in another mailbox too", () => {
    const candidates = extractHarvestCandidates(
      [
        {
          from: [{ name: "Both", email: "both@x.com" }],
          mailboxIds: { "mb-custom": true, "mb-junk": true },
        },
      ],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([]);
  });

  it("excludes the owner's own address, case-insensitively", () => {
    const candidates = extractHarvestCandidates(
      [
        { from: [{ name: "Me", email: "Me@Noxvytop.com" }], mailboxIds: { "mb-inbox": true } },
        { from: [{ name: "Ana", email: "ana@x.com" }], mailboxIds: { "mb-inbox": true } },
      ],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([{ name: "Ana", email: "ana@x.com" }]);
  });

  it("deduplicates repeated senders, keeping the first name seen", () => {
    const candidates = extractHarvestCandidates(
      [
        { from: [{ name: "Ana First", email: "ana@x.com" }], mailboxIds: { "mb-inbox": true } },
        { from: [{ name: "Ana Second", email: "ANA@X.COM" }], mailboxIds: { "mb-inbox": true } },
      ],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([{ name: "Ana First", email: "ana@x.com" }]);
  });

  it("skips messages without a usable From address", () => {
    const candidates = extractHarvestCandidates(
      [{ from: [], mailboxIds: { "mb-inbox": true } }, { mailboxIds: { "mb-inbox": true } }],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([]);
  });

  it("falls back to an empty name when the sender has none", () => {
    const candidates = extractHarvestCandidates(
      [{ from: [{ email: "noname@x.com" }], mailboxIds: { "mb-inbox": true } }],
      mailboxes,
      "me@noxvytop.com",
    );
    expect(candidates).toEqual([{ name: "", email: "noname@x.com" }]);
  });
});
