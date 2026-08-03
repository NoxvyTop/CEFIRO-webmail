import type { SenderAuthVerdict } from "@webmail/shared";

// GH #136 / GH #152: derives the reader's sender-authenticity verdict from the
// message's Authentication-Results header (RFC 8601). Deliberately free of
// I/O, like extractHarvestCandidates in contacts-harvest.ts, so it is trivial
// to unit test against real fixture values without a JMAP round trip.
//
// Trust model — authserv-id matching (RFC 8601 §5), NOT header position:
//
//  - An Authentication-Results header can appear more than once on a message,
//    and this server does not strip or rename a sender-injected one. The only
//    reliable way to see every instance in original order is the generic
//    `headers` property (RFC 8621 §4.1.1), which router.ts requests and passes
//    in here unmodified. (RFC 8621's `header:Authentication-Results:asText`
//    single-value accessor returns the LAST instance on this server, and the
//    `:all:asText` form is silently unsupported — both were confirmed live and
//    are why the generic property is used.)
//
//  - GH #136 originally trusted the FIRST (topmost) occurrence, on the
//    assumption that a receiving MTA always prepends its own trust header ahead
//    of the original content on every hop. That assumption is FALSE for
//    authenticated submission: when a user submits over authenticated SMTP,
//    this server adds NO Authentication-Results header of its own, so a header
//    the sender forged is the first and only one — and "trust the first" handed
//    that forged "dmarc=pass" straight to a green "verified sender" badge on a
//    message spoofed from an ordinary mailbox credential (reproduced live; see
//    GH #152). Position is not evidence of provenance.
//
//  - What IS evidence is the authserv-id: RFC 8601 §5 defines it as the first
//    token of the header (before the first ";"), naming the server that
//    performed the checks. This deployment configures its own via
//    JMAP_AUTHSERV_ID (core/config.ts). A header is trusted ONLY when its
//    authserv-id matches that configured value (case-insensitive, trimmed —
//    but a whole-token match, so `evil-mail.test` never matches `mail.test`).
//    The first matching header wins, so a genuine one is honoured wherever it
//    sits and a forged one with any other (or no) authserv-id is ignored — see
//    the exploit and ordering tests in sender-auth.test.ts.
//
//  - Fail-safe when unset: with no configured authserv-id, NO header can be
//    attributed to this deployment, so every verdict is "unknown" and no badge
//    is ever asserted. Better no badge than a forgeable one.
//
//  - The authserv-id check narrows WHICH header is trusted; it does not stop a
//    sender who forges the exact configured authserv-id on authenticated
//    submission, where this server adds none of its own to prepend ahead of it.
//    Closing that last gap needs the receiving MTA to strip inbound
//    Authentication-Results headers claiming its own authserv-id (RFC 8601 §5) —
//    an operational Stalwart-side setting, documented in docs/OPERATIONS.md.
//
//  - Authenticated submission that carries NO Authentication-Results header at
//    all (the seedInbox path in e2e/smtp-seed.ts) still resolves to "unknown",
//    never "pass": the absence of a header is not evidence of anything.

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

// Removes RFC 5322 parenthesised comments "(...)" — which may nest — from a
// header fragment, so a comment can neither hide nor be mistaken for the
// authserv-id token. Depth never goes negative on an unmatched ")": it is
// treated as a literal, matching splitTopLevel's discipline above.
function stripComments(value: string): string {
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

// Extracts the authserv-id (RFC 8601 §5) from one Authentication-Results header
// value (unfolding it first), lower-cased for a case-insensitive compare, or
// null when the header has no usable id. The authserv-id is the first
// ";"-delimited segment; within it, the id is the first whitespace-delimited
// token — an optional trailing version number (`authserv-id [ version ]`) and
// any CFWS/comment are not part of the id. Returning the whole token (not a
// prefix) is what makes the match in deriveSenderAuthVerdict a whole-id compare
// rather than a substring one, so a look-alike authserv-id cannot slip through.
function extractAuthServId(headerValue: string): string | null {
  const unfolded = unfold(headerValue);
  if (!unfolded) return null;
  const [firstSegment] = splitTopLevel(unfolded, ";");
  if (firstSegment === undefined) return null;
  const token = stripComments(firstSegment).trim().split(/\s+/)[0];
  return token ? token.toLowerCase() : null;
}

/**
 * Given a message's full, ordered `headers` list (RFC 8621 §4.1.1 shape) and
 * this deployment's own configured authserv-id (JMAP_AUTHSERV_ID), returns the
 * sender-authenticity verdict for the reader's trust indicator.
 *
 * Only an "Authentication-Results" header whose authserv-id matches `authServId`
 * (case-insensitive, trimmed, whole-token) is trusted — the first such header
 * wins, so a genuine one is honoured wherever it sits and a sender-forged one
 * with any other authserv-id is ignored (see the file header comment for the
 * full trust model, and GH #152 for the exploit this closes). When `authServId`
 * is unset, NO header can be trusted and the verdict is always "unknown"
 * (fail-safe). A missing/foreign header, an unparseable value, or a DMARC result
 * other than an unambiguous "pass"/"fail" all resolve to "unknown" rather than
 * ever guessing a "pass".
 */
export function deriveSenderAuthVerdict(
  headers: HeaderEntry[] | undefined | null,
  authServId: string | undefined | null,
): SenderAuthVerdict {
  if (!headers) return "unknown";

  // Fail-safe: with no authserv-id configured, no header can be attributed to
  // this deployment's own MTA, so none is trustworthy — every verdict is
  // "unknown" and no "verified sender" badge is ever asserted.
  const configured = authServId?.trim().toLowerCase();
  if (!configured) return "unknown";

  const header = headers.find(
    (entry) =>
      entry.name.toLowerCase() === "authentication-results" &&
      typeof entry.value === "string" &&
      extractAuthServId(entry.value) === configured,
  );
  if (!header) return "unknown";

  try {
    return verdictFromEntries(parseResInfoEntries(header.value));
  } catch {
    // Defense in depth: parseResInfoEntries is written to never throw, but a
    // malformed header must degrade to "unknown", not crash the thread
    // endpoint or, worse, propagate into a false verdict.
    return "unknown";
  }
}
