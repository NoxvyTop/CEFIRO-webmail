import { describe, expect, it } from "vitest";
import i18n from "../../app/i18n";

// GH #173 (item 3): the Trash header with a single message read "1 correos".
// The count strings must pluralize per language (i18next `_one`/`_other`), so a
// count of 1 renders the singular. This locks that in for both count strings
// (the list-header total and the per-conversation badge) across es and en.
describe("message count pluralization", () => {
  it("uses the Spanish singular for exactly one, plural otherwise", async () => {
    await i18n.changeLanguage("es");

    expect(i18n.t("mail.messageCount", { count: 1 })).toBe("1 correo");
    expect(i18n.t("mail.messageCount", { count: 0 })).toBe("0 correos");
    expect(i18n.t("mail.messageCount", { count: 5 })).toBe("5 correos");

    expect(i18n.t("mail.conversationCount", { count: 1 })).toBe("1 mensaje");
    expect(i18n.t("mail.conversationCount", { count: 3 })).toBe("3 mensajes");
  });

  it("uses the English singular for exactly one, plural otherwise", async () => {
    await i18n.changeLanguage("en");

    expect(i18n.t("mail.messageCount", { count: 1 })).toBe("1 message");
    expect(i18n.t("mail.messageCount", { count: 4 })).toBe("4 messages");

    await i18n.changeLanguage("es");
  });
});
