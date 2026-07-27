import type { SenderAuthVerdict } from "@webmail/shared";

// GH #136: derives the reader's sender-authenticity verdict from the
// message's Authentication-Results header (RFC 8601). Deliberately free of
// I/O, like extractHarvestCandidates in contacts-harvest.ts, so it is trivial
// to unit test against real fixture values without a JMAP round trip.
//
// Investigation summary (against a live Stalwart v0.16 e2e fixture — see
// e2e/fixtures/mail.ts and docker-compose.e2e.yml):
//
//  - RFC 8621's `header:Authentication-Results:asText` single-value property
//    accessor DOES work against this server, but only returns ONE instance
//    when a message carries more than one header with that name — and it
//    returned the LAST one in raw header order, not the first. Confirmed by
//    delivering a message whose body already contained a forged
//    "Authentication-Results: mail.cefiro.test; dmarc=pass ..." header via
//    unauthenticated SMTP: Stalwart does not strip or rename it before
//    prepending its own genuine header, and the singular `asText` accessor
//    resolved to the ATTACKER'S header, not Stalwart's. The `:all:asText`
//    form (which would return every instance) is silently unsupported by
//    this server version — it's dropped from the Email/get response with no
//    error.
//  - The only reliable way to get every header instance in original order is
//    the generic `headers` property (RFC 8621 §4.1.1), which router.ts
//    requests and passes in here unmodified. A receiving MTA prepends its own
//    trust headers ahead of the original message content on every hop, so
//    the FIRST (topmost) "Authentication-Results" entry is the one our own
//    server actually added; anything after it can be attacker-controlled.
//    This function trusts only that first occurrence — see the "forged a
//    second one" test in sender-auth.test.ts for the regression this guards.
//  - Authenticated, trusted SMTP submission (the seedInbox path used by
//    e2e/smtp-seed.ts) carries no Authentication-Results header at all —
//    Stalwart skips its authentication milter for that session. That must
//    resolve to "unknown", never "pass": the absence of a header is not
//    evidence of anything.

type HeaderEntry = { name: string; value: string };

type ResInfoEntry = { method: string; result: string };

// RFC 5322 header folding: a continuation line begins with CRLF followed by
// whitespace (WSP), and unfolding replaces that run with a single space.
// JMAP's `headers` property returns the raw, still-folded value (unlike the
// `:asText` accessor, which would unfold it for us) — this reproduces that
// unfolding by hand since `headers` is the only property this server can be
// trusted to return every header instance from (see the file header above).
function unfold(rawValue: string): string {
  return rawValue.replace(/\r\n[ \t]+/g, " ").trim();
}

// Splits `value` on `separator` at paren-depth 0 only, so a ";" inside an
// RFC 5322 comment "(...)" — e.g. "spf=none (mail.example.com: no SPF
// records found for x@y.test) smtp.helo=y.test" — never gets mistaken for a
// resinfo boundary. Depth never goes negative on an unmatched ")": treated as
// a literal character rather than desynchronizing the rest of the parse.
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// Matches the "method [ '/' version ] '=' result" prefix of an RFC 8601
// resinfo entry — e.g. "dmarc=pass" or "spf/1=neutral" — and ignores
// whatever comment/propspec text follows (smtp.mailfrom=..., header.from=...,
// policy.dmarc=..., etc.), since only the method name and its result matter
// for the verdict below.
const RESINFO_PATTERN = /^([A-Za-z][A-Za-z0-9-]*)(?:\/[0-9]+(?:\.[0-9]+)?)?\s*=\s*([A-Za-z][A-Za-z0-9-]*)/;

// Parses one Authentication-Results header value (already unfolded) into its
// resinfo entries. Never throws: any segment that doesn't match the expected
// shape is skipped rather than failing the whole header, since a partially
// understood header is still better evidence than none — as long as skipped
// entries can never turn into a false "pass" (they can't: only recognized
// "dmarc=..." entries feed the verdict in deriveSenderAuthVerdict below).
function parseResInfoEntries(headerValue: string): ResInfoEntry[] {
  const unfolded = unfold(headerValue);
  if (!unfolded) return [];

  const segments = splitTopLevel(unfolded, ";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return [];

  // The first segment is the authserv-id (optionally "id/version") — never a
  // resinfo entry, so it's dropped unconditionally.
  const resinfoSegments = segments.slice(1);

  const entries: ResInfoEntry[] = [];
  for (const segment of resinfoSegments) {
    // RFC 8601 §2.2: the entire resinfo run can be the single token "none",
    // meaning the server performed no authentication checks at all — not a
    // method=result pair, so it must not be forced through RESINFO_PATTERN.
    if (/^none$/i.test(segment)) continue;
    const match = RESINFO_PATTERN.exec(segment);
    if (!match) continue;
    entries.push({ method: match[1]!.toLowerCase(), result: match[2]!.toLowerCase() });
  }
  return entries;
}

// The verdict is keyed off DMARC's result exclusively — see the module
// header comment and senderAuthVerdictSchema in @webmail/shared for why raw
// SPF/DKIM results are not enough. If DMARC's result isn't unambiguously
// "pass" or "fail" (missing entirely, or more than one entry disagreeing,
// which would itself be suspicious), the verdict is "unknown" — never a
// silent "pass".
function verdictFromEntries(entries: ResInfoEntry[]): SenderAuthVerdict {
  const dmarcResults = new Set(
    entries.filter((entry) => entry.method === "dmarc").map((entry) => entry.result),
  );
  if (dmarcResults.size !== 1) return "unknown";
  const [result] = dmarcResults;
  if (result === "pass") return "pass";
  if (result === "fail") return "fail";
  // Covers "none", "neutral", "temperror", "permerror" and any method value
  // this parser doesn't recognize — none of these are positive evidence.
  return "unknown";
}

/**
 * Given a message's full, ordered `headers` list (RFC 8621 §4.1.1 shape),
 * returns the sender-authenticity verdict for the reader's trust indicator.
 * Only the FIRST "Authentication-Results" header is trusted (see the file
 * header comment for why); a missing header, an unparseable value, or a
 * DMARC result other than an unambiguous "pass"/"fail" all resolve to
 * "unknown" rather than ever guessing a "pass".
 */
export function deriveSenderAuthVerdict(headers: HeaderEntry[] | undefined | null): SenderAuthVerdict {
  if (!headers) return "unknown";

  const header = headers.find((entry) => entry.name.toLowerCase() === "authentication-results");
  if (!header || typeof header.value !== "string") return "unknown";

  try {
    return verdictFromEntries(parseResInfoEntries(header.value));
  } catch {
    // Defense in depth: parseResInfoEntries is written to never throw, but a
    // malformed header must degrade to "unknown", not crash the thread
    // endpoint or, worse, propagate into a false verdict.
    return "unknown";
  }
}
