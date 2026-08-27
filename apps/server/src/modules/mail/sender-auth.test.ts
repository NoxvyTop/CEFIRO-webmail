import { describe, expect, it } from "vitest";
import { deriveSenderAuthFacts, deriveSenderAuthVerdict } from "./sender-auth";

// GH #136 / GH #152: deriveSenderAuthVerdict is a pure function, deliberately
// free of I/O — same reasoning as extractHarvestCandidates in
// contacts-harvest.ts — so every case below is a plain unit test over a
// `headers` array shaped exactly like the JMAP Email "headers" property (RFC
// 8621 §4.1.1), plus this deployment's own configured authserv-id.
//
// The header values in these fixtures follow the RFC 8601 Authentication-Results
// grammar. Several are copied verbatim from a live Stalwart fixture (see the
// GH #136 investigation notes) to ground the parser in a real server's actual
// output, not just hand-crafted examples.

// The authserv-id used by every single-header fixture below, matching the
// "mail.example.com;" prefix of those header values.
const OWN = "mail.example.com";

function headerList(value: string, name = "Authentication-Results") {
  return [{ name, value }];
}

/** Verdict for a lone header, trusting the fixture's own authserv-id. */
function verdictFor(value: string, name = "Authentication-Results") {
  return deriveSenderAuthVerdict(headerList(value, name), OWN);
}

describe("deriveSenderAuthVerdict", () => {
  it("returns 'pass' for an explicit DMARC pass", () => {
    const verdict = verdictFor(
      "mail.example.com; spf=pass smtp.mailfrom=partner.test; dkim=pass header.d=partner.test; " +
        "dmarc=pass (p=reject) header.from=partner.test",
    );
    expect(verdict).toBe("pass");
  });

  it("returns 'fail' for an explicit DMARC fail", () => {
    const verdict = verdictFor(
      "mail.example.com; spf=fail smtp.mailfrom=attacker.test; dkim=fail header.d=attacker.test; " +
        "dmarc=fail (p=reject) header.from=cefiro.test",
    );
    expect(verdict).toBe("fail");
  });

  it("returns 'unknown' — not 'pass' — when there is no Authentication-Results header at all", () => {
    // Mirrors the real fixture: mail seeded via authenticated SMTP submission
    // (Stalwart adds no Authentication-Results header of its own for a trusted,
    // authenticated session) carries DKIM-Signature headers Stalwart itself
    // added, but no Authentication-Results header — confirmed live against the
    // running e2e Stalwart fixture (GH #137's seedInbox path).
    const headers = [
      { name: "Delivered-To", value: " admin@cefiro.test" },
      { name: "X-Spam-Status", value: " No" },
      { name: "DKIM-Signature", value: " v=1; a=ed25519-sha256; d=cefiro.test; ..." },
      { name: "From", value: " Carla Ibarra <carla@partner.test>" },
      { name: "Subject", value: " Q3 budget draft ready for review" },
    ];
    expect(deriveSenderAuthVerdict(headers, OWN)).toBe("unknown");
  });

  it("returns 'unknown' when the headers list is empty or undefined", () => {
    expect(deriveSenderAuthVerdict([], OWN)).toBe("unknown");
    expect(deriveSenderAuthVerdict(undefined, OWN)).toBe("unknown");
    expect(deriveSenderAuthVerdict(null, OWN)).toBe("unknown");
  });

  it("returns 'unknown' — not 'pass' — for an unparseable header value", () => {
    // "this is not a valid ..." has no ";", so its whole text is the authserv-id
    // segment and never matches OWN — as good as no trusted header.
    expect(verdictFor("this is not a valid Authentication-Results header")).toBe("unknown");
    expect(verdictFor("")).toBe("unknown");
    // A header that DOES match the authserv-id but has no resinfo after it still
    // degrades to "unknown" rather than a guessed pass.
    expect(verdictFor("mail.example.com;")).toBe("unknown");
  });

  it("returns 'unknown' for the bare 'none' token (RFC 8601 §2.2: no authentication was performed)", () => {
    expect(verdictFor("mail.example.com; none")).toBe("unknown");
  });

  // SPF/DKIM passing for a domain unrelated to the visible From header is
  // exactly how spoofing works — a pass on its own must never be read as the
  // sender being genuine. DMARC is what checks alignment with From, so the
  // verdict must come from DMARC's own result, not from SPF/DKIM directly.
  it("does NOT return 'pass' when SPF/DKIM pass but DMARC is absent from the header entirely", () => {
    const verdict = verdictFor(
      "mail.example.com; spf=pass smtp.mailfrom=attacker.test; dkim=pass header.d=attacker.test",
    );
    expect(verdict).not.toBe("pass");
    expect(verdict).toBe("unknown");
  });

  // The classic phishing shape: SPF/DKIM pass for the attacker's own domain
  // (aligned with envelope-from/d=, so they legitimately pass), but DMARC
  // itself reports fail because that domain does not align with the
  // impersonated visible From (cefiro.test) — this is real safety-relevant
  // signal, so it must surface as the warning verdict, not get lost among the
  // unrelated SPF/DKIM passes.
  it("does NOT return 'pass' when SPF/DKIM pass but DMARC explicitly fails due to From misalignment", () => {
    const verdict = verdictFor(
      "mail.example.com; spf=pass smtp.mailfrom=cuentas@cefiro-verificacion-segura.test; " +
        "dkim=pass header.d=cefiro-verificacion-segura.test; " +
        "dmarc=fail (p=reject sp=reject dis=none) header.from=cefiro.test",
    );
    expect(verdict).toBe("fail");
  });

  for (const result of ["none", "neutral", "temperror", "permerror"]) {
    it(`does NOT return 'pass' for DMARC result '${result}'`, () => {
      const verdict = verdictFor(`mail.example.com; dmarc=${result} header.from=partner.test`);
      expect(verdict).not.toBe("pass");
      expect(verdict).toBe("unknown");
    });
  }

  // Verbatim value observed on the live e2e Stalwart fixture for the spoofed
  // phishing fixture seeded by GH #137 (spam-2@cefiro-verificacion-segura.test,
  // display name "Cefiro Seguridad", impersonating the cefiro.test domain).
  // dmarc=none here (the .test domain publishes no DMARC record at all), so
  // this must resolve to unknown, not to any positive claim.
  it("returns 'unknown' for the real Authentication-Results value observed on the fixture's spoofed message", () => {
    const real =
      "mail.cefiro.test; spf=none (mail.cefiro.test: no SPF records found for postmaster@external-relay.test) " +
      "smtp.helo=external-relay.test; spf=none (mail.cefiro.test: no SPF records found for " +
      "cuentas@cefiro-verificacion-segura.test) smtp.mailfrom=cuentas@cefiro-verificacion-segura.test; " +
      "iprev=permerror (dns record not found) policy.iprev=172.23.0.1; " +
      "dmarc=none header.from=cefiro-verificacion-segura.test policy.dmarc=none";
    // authserv-id here is mail.cefiro.test, so trust it with that id.
    expect(deriveSenderAuthVerdict(headerList(real), "mail.cefiro.test")).toBe("unknown");
  });

  it("matches the header name case-insensitively", () => {
    const verdict = deriveSenderAuthVerdict(
      headerList("mail.example.com; dmarc=pass header.from=partner.test", "authentication-results"),
      OWN,
    );
    expect(verdict).toBe("pass");
  });

  it("unfolds a header value split across continuation lines (CRLF + whitespace)", () => {
    const folded =
      " mail.cefiro.test;\r\n\tspf=none (no record) smtp.helo=external-relay.test;\r\n\t" +
      "dmarc=pass header.from=partner.test policy.dmarc=none";
    expect(deriveSenderAuthVerdict(headerList(folded), "mail.cefiro.test")).toBe("pass");
  });

  // ── GH #152: authserv-id matching (RFC 8601 §5) ──────────────────────────
  //
  // The trust decision is keyed off the authserv-id, NOT header position. The
  // cases below are the point of the issue: they prove a sender-forged header —
  // the first and only one on an authenticated submission, where this server
  // adds none of its own — cannot mint a "verified sender" badge.
  describe("authserv-id matching (GH #152)", () => {
    // The live-reproduced exploit. On authenticated submission Stalwart adds no
    // Authentication-Results header of its own, so a header the SENDER forged is
    // the first and only one. Trusting it (the old #136 behaviour) handed a
    // green "verified sender" badge to a message spoofed from an ordinary
    // mailbox credential. Its authserv-id does not match ours, so it is ignored.
    it("ignores a forged DMARC pass whose authserv-id does not match ours (the authenticated-submission exploit)", () => {
      const headers = [
        { name: "Delivered-To", value: " victim@cefiro.test" },
        { name: "DKIM-Signature", value: " v=1; a=ed25519-sha256; d=cefiro.test; ..." },
        { name: "From", value: ' "Banco Seguro" <no-reply@banco-seguro.test>' },
        { name: "Subject", value: " Su cuenta ha sido bloqueada" },
        // Forged by the sender, claiming a pass from some other server.
        {
          name: "Authentication-Results",
          value: " forged-mta.attacker.test; dmarc=pass header.from=banco-seguro.test",
        },
      ];
      expect(deriveSenderAuthVerdict(headers, "mail.cefiro.test")).toBe("unknown");
    });

    it("returns the real verdict for a genuine header from the configured authserv-id", () => {
      const headers = [
        { name: "Received", value: " from mx.partner.test by mail.cefiro.test" },
        {
          name: "Authentication-Results",
          value: " mail.cefiro.test; dmarc=pass (p=reject) header.from=partner.test",
        },
        { name: "From", value: " Carla Ibarra <carla@partner.test>" },
      ];
      expect(deriveSenderAuthVerdict(headers, "mail.cefiro.test")).toBe("pass");
    });

    it("lets the genuine (matching authserv-id) header win over a forged one placed first, regardless of order", () => {
      const headers = [
        { name: "Delivered-To", value: " victim@cefiro.test" },
        // Forged, injected by the sender ABOVE the genuine one, claiming a pass.
        {
          name: "Authentication-Results",
          value: " forged-mta.attacker.test; dmarc=pass header.from=cefiro.test",
        },
        { name: "From", value: ' "Fake Trusted Sender" <attacker@spoof-test.test>' },
        // Genuine, added by our own receiving MTA: DMARC actually failed.
        {
          name: "Authentication-Results",
          value: " mail.cefiro.test; dmarc=fail (p=reject) header.from=cefiro.test",
        },
      ];
      // The forged header sits first, but it is not from our authserv-id, so the
      // genuine "fail" is what surfaces — never the forged "pass".
      expect(deriveSenderAuthVerdict(headers, "mail.cefiro.test")).toBe("fail");
    });

    it("trusts nothing when the authserv-id is unset — every verdict is 'unknown' (fail-safe)", () => {
      const genuinePass = headerList("mail.cefiro.test; dmarc=pass header.from=partner.test");
      for (const unset of [undefined, null, "", "   "]) {
        expect(deriveSenderAuthVerdict(genuinePass, unset)).toBe("unknown");
      }
    });

    it("matches the authserv-id case-insensitively and trimmed", () => {
      const headers = headerList("MAIL.Cefiro.TEST; dmarc=pass header.from=partner.test");
      expect(deriveSenderAuthVerdict(headers, "  mail.cefiro.test  ")).toBe("pass");
    });

    it("ignores an optional authserv-id version and any leading comment", () => {
      // RFC 8601 §5: `authserv-id [ CFWS version ]`, and CFWS may precede the id.
      const withVersion = headerList("mail.cefiro.test 1; dmarc=pass header.from=partner.test");
      expect(deriveSenderAuthVerdict(withVersion, "mail.cefiro.test")).toBe("pass");
      const withComment = headerList("(added by mx) mail.cefiro.test; dmarc=pass header.from=partner.test");
      expect(deriveSenderAuthVerdict(withComment, "mail.cefiro.test")).toBe("pass");
    });

    it("requires a whole-token match, not a loose substring", () => {
      // The attacker's authserv-id merely CONTAINS the configured one. A
      // substring check would trust it; a whole-token compare must not.
      const lookAlike = headerList("evil-mail.test; dmarc=pass header.from=cefiro.test");
      expect(deriveSenderAuthVerdict(lookAlike, "mail.test")).toBe("unknown");
      // The reverse (configured id merely a suffix/prefix of a longer id) is
      // just as untrusted.
      const longer = headerList("mail.test.attacker.example; dmarc=pass header.from=cefiro.test");
      expect(deriveSenderAuthVerdict(longer, "mail.test")).toBe("unknown");
    });
  });
});

// GH #314: the verdict alone says "DMARC passed", not "DMARC passed FOR THE
// DOMAIN THIS READER IS LOOKING AT". The positive trust tiers are tied to
// `from[0]`, so they need the domain DMARC actually evaluated — the
// `header.from=` propspec (RFC 8601 §2.3) of the SAME trusted header's `dmarc=`
// resinfo. Without it a message could carry a genuine `dmarc=pass` for one
// domain and a second, unevaluated From header for another, and the badge would
// vouch for the wrong one. Null is the answer to every doubt: absent, ambiguous,
// or two `dmarc=` entries naming different domains.
describe("deriveSenderAuthFacts (GH #314)", () => {
  it("returns the header.from domain alongside the verdict", () => {
    expect(
      deriveSenderAuthFacts(
        headerList("mail.example.com; dkim=pass header.d=partner.test; dmarc=pass (p=reject) header.from=partner.test"),
        OWN,
      ),
    ).toEqual({ verdict: "pass", dmarcFromDomain: "partner.test" });
  });

  it("returns a null domain when the dmarc entry carries no header.from propspec", () => {
    expect(deriveSenderAuthFacts(headerList("mail.example.com; dmarc=pass"), OWN)).toEqual({
      verdict: "pass",
      dmarcFromDomain: null,
    });
  });

  it("lowercases the domain and strips a trailing root dot", () => {
    expect(
      deriveSenderAuthFacts(headerList("mail.example.com; dmarc=pass header.from=Partner.TEST"), OWN)
        .dmarcFromDomain,
    ).toBe("partner.test");
    expect(
      deriveSenderAuthFacts(headerList("mail.example.com; dmarc=pass header.from=partner.test."), OWN)
        .dmarcFromDomain,
    ).toBe("partner.test");
  });

  it("ignores a header.from hidden inside an RFC 5322 comment", () => {
    expect(
      deriveSenderAuthFacts(
        headerList(
          "mail.example.com; dmarc=pass (p=reject dis=none header.from=evil.test) " +
            "header.from=partner.test policy.dmarc=none",
        ),
        OWN,
      ).dmarcFromDomain,
    ).toBe("partner.test");
  });

  it("returns null when two dmarc entries name different domains, or only one names any", () => {
    expect(
      deriveSenderAuthFacts(
        headerList("mail.example.com; dmarc=pass header.from=partner.test; dmarc=pass header.from=evil.test"),
        OWN,
      ).dmarcFromDomain,
    ).toBeNull();
    expect(
      deriveSenderAuthFacts(
        headerList("mail.example.com; dmarc=pass header.from=partner.test; dmarc=pass"),
        OWN,
      ).dmarcFromDomain,
    ).toBeNull();
  });

  it("returns null for a header that is not from the configured authserv-id, and for no header at all", () => {
    expect(
      deriveSenderAuthFacts(headerList("forged-mta.attacker.test; dmarc=pass header.from=partner.test"), OWN),
    ).toEqual({ verdict: "unknown", dmarcFromDomain: null });
    expect(deriveSenderAuthFacts(undefined, OWN)).toEqual({ verdict: "unknown", dmarcFromDomain: null });
    expect(deriveSenderAuthFacts(headerList("mail.example.com; dmarc=pass header.from=partner.test"), "")).toEqual({
      verdict: "unknown",
      dmarcFromDomain: null,
    });
  });
});
