import { describe, expect, it } from "vitest";
import type { Mailbox } from "@webmail/shared";
import i18n from "../i18n";
import { folderName, orderedMailboxes } from "./folders";

function mailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: "id", name: "name", parentId: null, role: null,
    sortOrder: 0, unreadEmails: 0, totalEmails: 0,
    ...overrides,
  };
}

describe("folderName", () => {
  it("localizes standard JMAP roles", () => {
    expect(folderName(mailbox({ role: "inbox", name: "INBOX" }), i18n.t)).toBe("Recibidos");
    expect(folderName(mailbox({ role: "sent", name: "Sent" }), i18n.t)).toBe("Enviados");
    expect(folderName(mailbox({ role: "archive", name: "Archive" }), i18n.t)).toBe("Archivados");
    expect(folderName(mailbox({ role: "trash", name: "Trash" }), i18n.t)).toBe("Papelera");
    expect(folderName(mailbox({ role: "junk", name: "Junk" }), i18n.t)).toBe("Spam");
    expect(folderName(mailbox({ role: "drafts", name: "Drafts" }), i18n.t)).toBe("Borradores");
  });

  it("falls back to the server name for roleless folders", () => {
    expect(folderName(mailbox({ role: null, name: "Team Projects" }), i18n.t)).toBe("Team Projects");
  });

  it("falls back to the server name for unknown roles", () => {
    expect(folderName(mailbox({ role: "important", name: "Important" }), i18n.t)).toBe("Important");
  });
});

describe("orderedMailboxes", () => {
  it("orders primary roles inbox, sent, archive regardless of server sortOrder", () => {
    const archive = mailbox({ id: "a", role: "archive", sortOrder: 0 });
    const inbox = mailbox({ id: "i", role: "inbox", sortOrder: 2 });
    const sent = mailbox({ id: "s", role: "sent", sortOrder: 1 });

    expect(orderedMailboxes([archive, inbox, sent]).map((m) => m.id)).toEqual(["i", "s", "a"]);
  });

  it("groups secondary roles (trash, junk, drafts) after the primary roles", () => {
    const drafts = mailbox({ id: "d", role: "drafts" });
    const inbox = mailbox({ id: "i", role: "inbox" });
    const junk = mailbox({ id: "j", role: "junk" });
    const trash = mailbox({ id: "t", role: "trash" });

    expect(orderedMailboxes([drafts, junk, trash, inbox]).map((m) => m.id)).toEqual(["i", "t", "j", "d"]);
  });

  it("appends roleless and unknown-role folders after the known groups", () => {
    const inbox = mailbox({ id: "i", role: "inbox" });
    const custom = mailbox({ id: "c", role: null, name: "Team Projects" });
    const other = mailbox({ id: "o", role: "important" });

    expect(orderedMailboxes([custom, other, inbox]).map((m) => m.id)).toEqual(["i", "c", "o"]);
  });

  it("omits roles that are not present without leaving gaps", () => {
    const inbox = mailbox({ id: "i", role: "inbox" });
    const archive = mailbox({ id: "a", role: "archive" });

    expect(orderedMailboxes([archive, inbox]).map((m) => m.id)).toEqual(["i", "a"]);
  });
});
