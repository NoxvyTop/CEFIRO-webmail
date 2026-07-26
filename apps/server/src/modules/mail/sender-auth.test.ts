import { describe, expect, it } from "vitest";
import { deriveSenderAuthVerdict } from "./sender-auth";

// GH #136: deriveSenderAuthVerdict is a pure function, deliberately free of
// I/O — same reasoning as extractHarvestCandidates in contacts-harvest.ts —
// so every case below is a plain unit test over a `headers` array shaped
// exactly like the JMAP Email "headers" property (RFC 8621 §4.1.1).
//
// The header values in these fixtures follow the RFC 8601 Authentication-Results
// grammar. Several are copied verbatim from a live Stalwart fixture (see the
// GH #136 investigation notes) to ground the parser in a real server's actual
// output, not just hand-crafted examples.

function headerList(value: string, name = "Authentication-Results") {
  return [{ name, value }];
}

describe("deriveSenderAuthVerdict", () => {
  it("returns 'pass' for an explicit DMARC pass", () => {
    const verdict = deriveSenderAuthVerdict(
      headerList(
        "mail.example.com; spf=pass smtp.mailfrom=partner.test; dkim=pass header.d=partner.test; " +
          "dmarc=pass (p=reject) header.from=partner.test",
      ),
    );
    expect(verdict).toBe("pass");
  });

  it("returns 'fail' for an explicit DMARC fail", () => {
    const verdict = deriveSenderAuthVerdict(
      headerList(
        "mail.example.com; spf=fail smtp.mailfrom=attacker.test; dkim=fail header.d=attacker.test; " +
          "dmarc=fail (p=reject) header.from=cefiro.test",
      ),
    );
    expect(verdict).toBe("fail");
  });

  it("returns 'unknown' — not 'pass' — when there is no Authentication-Results header at all", () => {
    // Mirrors the real fixture: mail seeded via authenticated SMTP submission
    // (Stalwart skips its authentication milter for a trusted, authenticated
    // session) carries DKIM-Signature headers Stalwart itself added, but no
    // Authentication-Results header — confirmed live against the running
    // e2e Stalwart fixture (GH #137's seedInbox path).
    const headers = [
      { name: "Delivered-To", value: " admin@cefiro.test" },
      { name: "X-Spam-Status", value: " No" },
      { name: "DKIM-Signature", value: " v=1; a=ed25519-sha256; d=cefiro.test; ..." },
      { name: "From", value: " Carla Ibarra <carla@partner.test>" },
      { name: "Subject", value: " Q3 budget draft ready for review" },
    ];
    expect(deriveSenderAuthVerdict(headers)).toBe("unknown");
  });

  it("returns 'unknown' when the headers list is empty or undefined", () => {
    expect(deriveSenderAuthVerdict([])).toBe("unknown");
    expect(deriveSenderAuthVerdict(undefined)).toBe("unknown");
  });

  it("returns 'unknown' — not 'pass' — for an unparseable header value", () => {
    expect(deriveSenderAuthVerdict(headerList("this is not a valid Authentication-Results header"))).toBe(
      "unknown",
    );
    expect(deriveSenderAuthVerdict(headerList(""))).toBe("unknown");
  });

  it("returns 'unknown' for the bare 'none' token (RFC 8601 §2.2: no authentication was performed)", () => {
    expect(deriveSenderAuthVerdict(headerList("mail.example.com; none"))).toBe("unknown");
  });

  // SPF/DKIM passing for a domain unrelated to the visible From header is
  // exactly how spoofing works — a pass on its own must never be read as the
  // sender being genuine. DMARC is what checks alignment with From, so the
  // verdict must come from DMARC's own result, not from SPF/DKIM directly.
  it("does NOT return 'pass' when SPF/DKIM pass but DMARC is absent from the header entirely", () => {
    const verdict = deriveSenderAuthVerdict(
      headerList("mail.example.com; spf=pass smtp.mailfrom=attacker.test; dkim=pass header.d=attacker.test"),
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
    const verdict = deriveSenderAuthVerdict(
      headerList(
        "mail.example.com; spf=pass smtp.mailfrom=cuentas@cefiro-verificacion-segura.test; " +
          "dkim=pass header.d=cefiro-verificacion-segura.test; " +
          "dmarc=fail (p=reject sp=reject dis=none) header.from=cefiro.test",
      ),
    );
    expect(verdict).toBe("fail");
  });

  for (const result of ["none", "neutral", "temperror", "permerror"]) {
    it(`does NOT return 'pass' for DMARC result '${result}'`, () => {
      const verdict = deriveSenderAuthVerdict(
        headerList(`mail.example.com; dmarc=${result} header.from=partner.test`),
      );
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
    expect(deriveSenderAuthVerdict(headerList(real))).toBe("unknown");
  });

  it("matches the header name case-insensitively", () => {
    const verdict = deriveSenderAuthVerdict(
      headerList("mail.example.com; dmarc=pass header.from=partner.test", "authentication-results"),
    );
    expect(verdict).toBe("pass");
  });

  it("unfolds a header value split across continuation lines (CRLF + whitespace)", () => {
    const folded =
      " mail.cefiro.test;\r\n\tspf=none (no record) smtp.helo=external-relay.test;\r\n\t" +
      "dmarc=pass header.from=partner.test policy.dmarc=none";
    expect(deriveSenderAuthVerdict(headerList(folded))).toBe("pass");
  });

  // The critical anti-spoofing case: this Stalwart e2e fixture does NOT strip
  // a sender-injected Authentication-Results header before adding its own
  // (confirmed live — see GH #136 investigation notes), and the JMAP
  // "header:Authentication-Results:asText" single-value accessor returns
  // whichever instance is LAST in the raw header list, not necessarily the
  // genuine one. A receiving MTA always prepends its own trust headers ahead
  // of the original message content, so the first (topmost) occurrence is the
  // one actually added by our own server; anything after it can be attacker-
  // controlled. deriveSenderAuthVerdict is given the full ordered `headers`
  // array specifically so it can pick the first occurrence itself, instead of
  // trusting an accessor that (on this server) surfaces the wrong one.
  it("trusts only the FIRST Authentication-Results header when the message forged a second one", () => {
    const headers = [
      { name: "Delivered-To", value: " admin@cefiro.test" },
      // Genuine header, added by the receiving server: DMARC did not pass.
      { name: "Authentication-Results", value: " mail.cefiro.test; dmarc=none header.from=spoof-test.test" },
      { name: "From", value: ' "Fake Trusted Sender" <attacker@spoof-test.test>' },
      { name: "Subject", value: " Header injection probe" },
      // Forged header, injected by the sender inside the original message,
      // claiming a pass it never earned.
      { name: "Authentication-Results", value: " mail.cefiro.test; dmarc=pass header.from=cefiro.test" },
    ];
    expect(deriveSenderAuthVerdict(headers)).toBe("unknown");
  });
});
