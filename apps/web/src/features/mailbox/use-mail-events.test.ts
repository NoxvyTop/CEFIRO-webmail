import { describe, expect, it } from "vitest";
import { invalidationKeysForStateChange } from "./useMailEvents";

// A JMAP StateChange (RFC 8620 §7.1) names the types whose state moved, so the
// client can refetch what changed instead of everything under ["mail"].
function stateChange(types: Record<string, string>) {
  return JSON.stringify({ "@type": "StateChange", changed: { "account-1": types } });
}

describe("invalidationKeysForStateChange", () => {
  it("refetches the listing and the open thread when mail changed", () => {
    expect(invalidationKeysForStateChange(stateChange({ Email: "abc" }))).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
    ]);
  });

  it("refetches only the folder list when mailbox state changed", () => {
    // Unread counts moved; the messages already on screen did not.
    expect(invalidationKeysForStateChange(stateChange({ Mailbox: "def" }))).toEqual([
      ["mail", "mailboxes"],
    ]);
  });

  it("refetches both when both changed", () => {
    expect(
      invalidationKeysForStateChange(stateChange({ Email: "abc", Mailbox: "def" })),
    ).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
      ["mail", "mailboxes"],
    ]);
  });

  it("merges the types across accounts without repeating a key", () => {
    const raw = JSON.stringify({
      changed: { "account-1": { Email: "abc" }, "account-2": { Email: "xyz", Mailbox: "def" } },
    });
    expect(invalidationKeysForStateChange(raw)).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
      ["mail", "mailboxes"],
    ]);
  });

  it.each([
    ["not json at all", "<<<"],
    ["an empty payload", ""],
    ["a ping with no changed map", JSON.stringify({ "@type": "StateChange" })],
    ["an unrecognised type", stateChange({ CalendarEvent: "abc" })],
  ])("falls back to every mail-data key given %s", (_case, raw) => {
    // Refetching a little too much beats dropping a notification: the user
    // would be looking at a mailbox that silently stopped updating. The
    // fallback is still narrower than the old ["mail"] sweep, which also swept
    // identities, preferences and signatures.
    expect(invalidationKeysForStateChange(raw)).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
      ["mail", "mailboxes"],
    ]);
  });

  it("never invalidates data this stream cannot report on", () => {
    const everyKey = [
      ...invalidationKeysForStateChange(stateChange({ Email: "a", Mailbox: "b" })),
      ...invalidationKeysForStateChange("<<<"),
    ].map((key) => key.join("/"));

    // The server subscribes to Email and Mailbox only (mail/router.ts's
    // {types} substitution), so a change to any of these cannot arrive on this
    // stream — refetching them here is provably wasted work.
    for (const untouchable of ["mail/identities", "mail/preferences", "mail/signatures"]) {
      expect(everyKey).not.toContain(untouchable);
    }
  });
});
