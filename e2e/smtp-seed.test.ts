import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  buildRawMessage,
  extractEnvelopeAddress,
  prepareMimePart,
  readResponse,
  type SeedEmail,
  withConversationRetry,
} from "./smtp-seed";

// Regression cover for GH #184. A Stalwart that is still finishing startup
// accepts the TCP/TLS socket and then closes it *mid-conversation* — before it
// ever answers EHLO or the DATA terminator. connectWithRetry only guards the
// handshake, so that drop is invisible to it; readResponse instead surfaces it
// as "SMTP connection closed before a final response arrived". withConversationRetry
// wraps the whole per-message conversation so this premature close is retried
// with the existing bounded budget/backoff, rather than failing the seed on the
// first drop. These tests pin that behavior using the real readResponse close
// path (fed by a bare EventEmitter standing in for the socket), so they exercise
// the exact error the seeder throws in CI, not a hand-rolled stand-in.

// readResponse only ever uses the socket's EventEmitter surface (on/off for
// "data"/"error"/"close"), so a bare EventEmitter is a faithful stand-in — but
// its declared parameter is the full net.Socket, hence the widening cast. Kept
// in one helper so the cast is stated once, with this reason.
function asSocket(emitter: EventEmitter): Socket {
  return emitter as unknown as Socket;
}

// Produces the exact premature-close rejection (empty buffer) via the real
// readResponse "close" handler.
function prematureClose(): Promise<unknown> {
  const socket = new EventEmitter();
  const pending = readResponse(asSocket(socket));
  socket.emit("close");
  return pending;
}

test("readResponse resolves on a final SMTP reply line", async () => {
  const socket = new EventEmitter();
  const pending = readResponse(asSocket(socket));
  socket.emit("data", Buffer.from("250 OK\r\n"));
  const response = await pending;
  expect(response.code).toBe(250);
});

test("readResponse rejects when the socket closes before any reply", async () => {
  await expect(prematureClose()).rejects.toThrow(
    /SMTP connection closed before a final response arrived/,
  );
});

test("withConversationRetry retries a mid-conversation premature close, then succeeds", async () => {
  let attempts = 0;
  const result = await withConversationRetry("seedJunk retry", async () => {
    attempts += 1;
    if (attempts === 1) {
      // First attempt drops mid-conversation — must be retried, not fatal.
      await prematureClose();
    }
    return "delivered";
  });
  expect(result).toBe("delivered");
  expect(attempts).toBe(2);
});

test("withConversationRetry stays bounded and surfaces the close error after exhausting retries", async () => {
  let attempts = 0;
  const run = withConversationRetry("seedJunk exhausted", async () => {
    attempts += 1;
    // Never recovers: every attempt drops mid-conversation.
    await prematureClose();
    return "unreachable";
  });
  await expect(run).rejects.toThrow(
    /failed after 5 attempts: SMTP connection closed before a final response arrived/,
  );
  // CONNECT_RETRIES === 5: the retry is bounded, never an infinite loop.
  expect(attempts).toBe(5);
}, 15_000);

// GH #247. Everything below is the message the seeder puts on the wire. None of
// it can fail the seed — a malformed DATA block is accepted by Stalwart and
// delivered as something other than what the fixture says — so a bug here shows
// up as a mail spec failing against a body it never received, or as a Junk
// fixture that silently never arrives. That is the harness-bug class this issue
// is about: a green suite that proved nothing.

const PLAIN: SeedEmail = {
  from: "Carla Ibarra <carla@partner.test>",
  to: "admin@cefiro.test",
  subject: "Presupuesto revisado",
  body: "Hola,\nadjunto el presupuesto.",
  messageId: "presupuesto@partner.test",
};

/** The DATA block's end-of-data terminator, as RFC 5321 §4.1.1.4 defines it. */
const END_OF_DATA = "\r\n.\r\n";

test("prepareMimePart normalizes every line ending to CRLF", () => {
  // Fixtures are authored as ordinary template literals, so they arrive with
  // bare LFs that no SMTP server is obliged to accept inside DATA.
  expect(prepareMimePart("uno\ndos\r\ntres")).toBe("uno\r\ndos\r\ntres");
});

test("prepareMimePart dot-stuffs a line that starts with a dot", () => {
  // Without the stuffing, ".\r\n" inside a body IS the end-of-data terminator:
  // the message is truncated there and the rest is read as SMTP commands.
  expect(prepareMimePart(".hidden\nplain")).toBe("..hidden\r\nplain");
  // Only a LEADING dot is doubled; one mid-line is ordinary text.
  expect(prepareMimePart("a.b")).toBe("a.b");
});

test("buildRawMessage terminates the DATA block exactly once, at the end", () => {
  const raw = buildRawMessage(PLAIN, "run-1");
  expect(raw.endsWith(END_OF_DATA)).toBe(true);
  // An earlier terminator would truncate the message; this is the assertion
  // dot-stuffing exists to keep true for hostile bodies.
  expect(raw.indexOf(END_OF_DATA)).toBe(raw.length - END_OF_DATA.length);
});

test("buildRawMessage keeps a body that opens with a dot inside the message", () => {
  const raw = buildRawMessage({ ...PLAIN, body: ".\nfin" }, "run-1");
  expect(raw.indexOf(END_OF_DATA)).toBe(raw.length - END_OF_DATA.length);
  expect(raw).toContain("\r\n..\r\nfin");
});

test("buildRawMessage namespaces the Message-ID per run", () => {
  // Stalwart's default ruleset deduplicates by Message-ID and keeps the FIRST
  // delivery silently, so a fixture re-seeded with its literal id no-ops
  // against whatever mailbox the previous run left it in.
  expect(buildRawMessage(PLAIN, "run-1")).toContain(
    "Message-ID: <run-1.presupuesto@partner.test>",
  );
  expect(buildRawMessage(PLAIN, "run-2")).toContain(
    "Message-ID: <run-2.presupuesto@partner.test>",
  );
});

test("buildRawMessage sends a plain fixture as a single text/plain part", () => {
  const raw = buildRawMessage(PLAIN, "run-1");
  expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
  expect(raw).not.toContain("multipart/alternative");
  // Headers end at the first blank line; the body follows it.
  expect(raw).toContain("\r\n\r\nHola,\r\nadjunto el presupuesto.");
});

test("buildRawMessage sends an html fixture as multipart/alternative, text part first", () => {
  const raw = buildRawMessage({ ...PLAIN, html: "<p>Hola</p>" }, "run-1");
  const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
  expect(boundary).toBeDefined();
  // RFC 2046 §5.1.4: the alternatives are ordered worst-to-best, so the
  // text/plain fallback has to precede the text/html part.
  expect(raw.indexOf("Content-Type: text/plain")).toBeLessThan(
    raw.indexOf("Content-Type: text/html"),
  );
  // Opening delimiter for each part, and the closing delimiter exactly once.
  expect(raw.split(`--${boundary}\r\n`).length - 1).toBe(2);
  expect(raw).toContain(`\r\n--${boundary}--\r\n`);
  expect(raw.endsWith(END_OF_DATA)).toBe(true);
});

test("buildRawMessage derives a boundary that is a legal MIME token", () => {
  // The id becomes part of a Content-Type parameter; an unescaped space or
  // quote there makes the whole multipart structure unparseable.
  const raw = buildRawMessage(
    { ...PLAIN, messageId: 'raro id "con" espacios@x.test', html: "<p>x</p>" },
    "run 1",
  );
  const boundary = raw.match(/boundary="([^"]+)"/)?.[1] ?? "";
  expect(boundary).toMatch(/^[A-Za-z0-9._-]+$/);
});

test("extractEnvelopeAddress unwraps a display-name mailbox", () => {
  // seedJunk uses this for MAIL FROM: sending the display string verbatim is a
  // syntax error, and the junk fixtures never arrive at all.
  expect(extractEnvelopeAddress("Carla Ibarra <carla@partner.test>")).toBe("carla@partner.test");
});

test("extractEnvelopeAddress passes a bare address through untouched", () => {
  expect(extractEnvelopeAddress("carla@partner.test")).toBe("carla@partner.test");
});
