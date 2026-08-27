import { afterEach, describe, expect, it } from "vitest";
import type { EmailAddress } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { describeAudience } from "./audience";

const me: EmailAddress = { name: "Me", email: "me@example.com" };
const bob: EmailAddress = { name: "Bob", email: "bob@example.com" };
const carol: EmailAddress = { name: "Carol", email: "carol@example.com" };
const dave: EmailAddress = { name: null, email: "dave@example.com" };

const identityEmails = ["me@example.com"];

function audience(to: EmailAddress[], cc: EmailAddress[], identities = identityEmails) {
  return describeAudience(to, cc, identities, i18n.t);
}

describe("describeAudience", () => {
  afterEach(async () => {
    await i18n.changeLanguage("es");
  });

  describe("when I am among the recipients", () => {
    it("says just 'para mí' when I'm the only recipient", () => {
      expect(audience([me], [])).toBe("para mí");
    });

    it("names the single other recipient", () => {
      expect(audience([me, bob], [])).toBe("para mí y Bob");
    });

    it("falls back to the email when the other recipient has no name", () => {
      expect(audience([me, dave], [])).toBe("para mí y dave@example.com");
    });

    it("counts multiple others", () => {
      expect(audience([me, bob, carol], [])).toBe("para mí y 2 más");
    });

    it("counts me from cc, not only to", () => {
      expect(audience([bob], [me])).toBe("para mí y Bob");
    });
  });

  describe("when I am not among the recipients (list/bcc delivery)", () => {
    it("falls back to 'para mí' when there are no recipients at all", () => {
      expect(audience([], [])).toBe("para mí");
    });

    it("names the single recipient", () => {
      expect(audience([bob], [])).toBe("para Bob");
    });

    it("names the first recipient and counts the rest", () => {
      expect(audience([bob, carol, dave], [])).toBe("para Bob y 2 más");
    });
  });

  describe("recipient normalization", () => {
    it("dedupes the same address appearing in both to and cc", () => {
      // Bob in both lists is one person, so it stays "y Bob", not "y 1 más".
      expect(audience([me, bob], [bob])).toBe("para mí y Bob");
    });

    it("dedupes case-insensitively by email", () => {
      const bobUpper: EmailAddress = { name: "Bob", email: "BOB@EXAMPLE.COM" };
      expect(audience([bob], [bobUpper])).toBe("para Bob");
    });

    it("matches my identity case-insensitively", () => {
      const meUpper: EmailAddress = { name: "Me", email: "ME@EXAMPLE.COM" };
      expect(audience([meUpper, bob], [])).toBe("para mí y Bob");
    });
  });

  it("renders the English copy under the en locale", async () => {
    await i18n.changeLanguage("en");
    expect(audience([me], [])).toBe("to me");
    expect(audience([me, bob], [])).toBe("to me and Bob");
    expect(audience([me, bob, carol], [])).toBe("to me and 2 more");
    expect(audience([bob], [])).toBe("to Bob");
    expect(audience([bob, carol, dave], [])).toBe("to Bob and 2 more");
  });
});
