import { connect as connectTls, type ConnectionOptions, type TLSSocket } from "node:tls";
import { connect as connectPlain, type Socket } from "node:net";

// Minimal SMTP client — no new dependency, just enough of the protocol to
// inject inbound mail into the Stalwart fixture's admin@cefiro.test mailbox
// for E2E seeding. Two delivery paths are exposed (seedInbox / seedJunk)
// because Stalwart's mailbox placement depends on which one is used:
//
// Authenticated submission over implicit TLS on port 465 (seedInbox): AUTH
// is only offered over TLS (a plaintext "AUTH LOGIN" on port 25 gets
// "503 5.5.1 AUTH not allowed"), hence implicit TLS (docker-compose.e2e.yml
// publishes it as 8465:465). Stalwart skips spam classification for an
// authenticated session, which reliably lands the mail in Inbox. Authenticated
// submission also requires the envelope MAIL FROM to match the authenticated
// identity ("501 5.5.4 You are not allowed to send from this address"
// otherwise) — so MAIL FROM uses the Stalwart account's own address while
// each message's RFC5322 "From" header keeps the distinct fixture sender,
// which is what the reading pane actually displays.
//
// Plain, unauthenticated delivery on port 25 (seedJunk): unauthenticated
// MAIL FROM/RCPT TO on port 25 IS accepted (250 on both, no AUTH required
// for local delivery) — and Stalwart's spam filter runs on that
// unauthenticated path and reliably classifies mail from an external,
// unverified sender domain (no SPF/DKIM) straight into "Junk Mail" instead
// of "Inbox" (confirmed against the running fixture via a live JMAP
// Mailbox/Email/get round trip — two probe messages delivered this way both
// landed in the "Junk Mail" mailbox, id role "junk"). This is the path spam/
// promotional fixtures should use, since it exercises the real classifier
// instead of forcing a mailbox assignment.

export interface SeedEmail {
  /** RFC5322 From header value, e.g. "Carla Ibarra <carla@partner.test>". */
  from: string;
  /** Envelope + header recipient, e.g. "admin@cefiro.test". */
  to: string;
  subject: string;
  /** Plain-text body. Used as-is when `html` is absent; used as the
   * text/plain alternative part when `html` is present. */
  body: string;
  /** Local-part of the Message-ID, made unique per test run by seedInbox/seedJunk. */
  messageId: string;
  /**
   * Optional HTML body. When set, the message is sent as
   * multipart/alternative (text/plain from `body` first, text/html from
   * `html` second) instead of a plain text/plain message — the same MIME
   * shape real marketing mail uses. Omit for plain-text-only fixtures.
   */
  html?: string;
}

interface SmtpResponse {
  code: number;
  text: string;
}

const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 750;
const CONNECT_TIMEOUT_MS = 5_000;

// The fixture's self-signed certificate is regenerated fresh on every
// container boot, but always for "DNS:localhost" — confirmed by inspecting a
// running container's cert directly (`openssl s_client -connect <host>:465
// -servername localhost | openssl x509 -noout -ext subjectAltName`). It does
// NOT vary with the container's actual hostname or with how it is reached.
// TLS hostname verification in seedInbox is therefore pinned to this
// constant as an explicit `servername`, decoupled from the `host` used to
// open the TCP connection — so seeding keeps working when `host` is a Docker
// service name (e.g. "stalwart" inside a GitHub Actions `services:` network)
// instead of "localhost", without weakening the certificate pinning below.
const STALWART_CERT_SERVERNAME = "localhost";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries an entire per-message SMTP conversation, not just the initial
// connect. connectWithRetry only covers the TCP/TLS handshake, but a Stalwart
// that is still finishing startup does something the connect retry cannot see:
// it ACCEPTS the socket and then closes it mid-conversation, before answering
// EHLO or the DATA terminator. That surfaces as readResponse's onClose —
// "SMTP connection closed before a final response arrived (buffer: "")" — and
// flaked the e2e seed intermittently even after the health check was tightened
// (GH #179 fixed the health check but explicitly left this as follow-up). Each
// message already gets its own fresh connection, so re-running the whole
// deliver block is safe: a half-spoken conversation on a dropped socket left
// nothing on the server (Message-IDs are per-run unique, so even a partial
// retry cannot double-deliver). Reuses the connect retry budget/backoff.
export async function withConversationRetry<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (attempt < CONNECT_RETRIES) await sleep(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `${label} failed after ${CONNECT_RETRIES} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function connectWithRetry(host: string, port: number, tlsOptions: ConnectionOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryConnect() {
      attempt += 1;
      const socket = connectTls({ host, port, ...tlsOptions });
      const onError = async (err: Error) => {
        socket.destroy();
        if (attempt >= CONNECT_RETRIES) {
          reject(new Error(`could not connect to SMTPS ${host}:${port} after ${attempt} attempts: ${err.message}`));
          return;
        }
        await sleep(CONNECT_RETRY_DELAY_MS);
        tryConnect();
      };
      socket.once("error", onError);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => onError(new Error("connect timeout")));
      socket.once("secureConnect", () => {
        socket.setTimeout(0);
        socket.removeListener("error", onError);
        resolve(socket);
      });
    }

    tryConnect();
  });
}

// Plain (non-TLS) counterpart of connectWithRetry, used by seedJunk for the
// unauthenticated port-25 delivery path — no cert to pin, just a bare TCP
// connect with the same retry behavior since Stalwart may still be starting
// up right after `docker compose up`.
function connectPlainWithRetry(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryConnect() {
      attempt += 1;
      const socket = connectPlain({ host, port });
      const onError = async (err: Error) => {
        socket.destroy();
        if (attempt >= CONNECT_RETRIES) {
          reject(new Error(`could not connect to SMTP ${host}:${port} after ${attempt} attempts: ${err.message}`));
          return;
        }
        await sleep(CONNECT_RETRY_DELAY_MS);
        tryConnect();
      };
      socket.once("error", onError);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => onError(new Error("connect timeout")));
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeListener("error", onError);
        resolve(socket);
      });
    }

    tryConnect();
  });
}

function derToPem(der: Buffer): string {
  const base64 = der.toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

// Stalwart's fixture certificate is self-signed and regenerated on every
// container boot (see e2e/stalwart/README.md — it's not part of the
// committed seed data), so it can't be pinned as a static file. Instead this
// does trust-on-first-use: one bootstrap connection reads whatever
// certificate the fixture is presenting right now (unauthenticated at the
// TLS layer, but this is a loopback connection straight to the container we
// just built/started ourselves — there's no network path for a
// man-in-the-middle to intercept), then every real SMTP connection for this
// seeding run pins that exact certificate via `ca`, with normal hostname
// verification left enabled (the fixture's cert SAN is "DNS:localhost",
// matching how this connects). This avoids a blanket
// `rejectUnauthorized: false` while still tolerating the fixture's
// self-signed, ephemeral cert.
async function fetchFixtureCertificate(host: string, port: number): Promise<string> {
  const socket = await connectWithRetry(host, port, { rejectUnauthorized: false });
  try {
    const cert = socket.getPeerCertificate(true);
    if (!cert?.raw) {
      throw new Error(`could not read a TLS certificate from ${host}:${port}`);
    }
    return derToPem(cert.raw);
  } finally {
    socket.destroy();
  }
}

// Reads until a final (non-continuation) SMTP response line, e.g. "250 OK" —
// as opposed to a continuation line like "250-STARTTLS". Typed as plain
// `Socket` (not `TLSSocket`) so it works for both the TLS connection used by
// seedInbox and the plain connection used by seedJunk — TLSSocket is a
// subclass of net.Socket, so callers passing either work unchanged.
export function readResponse(socket: Socket): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      // Only treat the response as complete once the buffer ends with a full
      // CRLF terminator AND the last complete line matches a final reply
      // ("250 OK", not a continuation like "250-STARTTLS"). Matching against
      // the last split segment alone (without requiring a trailing "\r\n")
      // can false-positive on a partial, still-in-flight line that happens to
      // start with "\d{3} " but hasn't actually been terminated yet.
      if (!buffer.endsWith("\r\n")) return;
      const lines = buffer.split("\r\n").filter((line) => line.length > 0);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buffer });
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error(`SMTP connection closed before a final response arrived (buffer: ${JSON.stringify(buffer)})`));
    }

    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

// Waits for the next response, then (optionally) writes a command line.
// Attaching the listener before writing avoids a race where a fast reply
// arrives before we start listening.
function sendCommand(socket: Socket, command: string | null): Promise<SmtpResponse> {
  const response = readResponse(socket);
  if (command !== null) socket.write(`${command}\r\n`);
  return response;
}

// Like sendCommand, but writes a raw, already CRLF-terminated payload
// verbatim (no extra "\r\n" appended) — used for the DATA block, which
// already ends with the "\r\n.\r\n" end-of-data terminator built by
// buildRawMessage. Appending another "\r\n" after that terminator would send
// a stray empty line the server reads as a new (invalid) command.
function sendRaw(socket: Socket, payload: string): Promise<SmtpResponse> {
  const response = readResponse(socket);
  socket.write(payload);
  return response;
}

// Normalizes to strict CRLF line endings (so fixture bodies/HTML can be
// authored with ordinary "\n" template literals) and dot-stuffs any line
// that starts with "." per RFC 5321 §4.5.2, so an accidental leading dot in
// a fixture body/HTML part can't be mistaken for the end-of-DATA terminator.
function prepareMimePart(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function buildRawMessage(message: SeedEmail, runId: string): string {
  const date = new Date().toUTCString().replace("GMT", "+0000");
  // Stalwart deduplicates inbound mail by Message-ID (the "duplicate" Sieve
  // extension in its default ruleset) — silently keeping only the first
  // delivery instead of erroring on the repeat. Re-running the seeder
  // against a fixture whose data wasn't reset (e.g. iterating on a spec
  // without a fresh `docker compose down && up`) would otherwise re-send the
  // fixtures' literal Message-IDs and have every retry silently no-op
  // against whatever mailbox the *first* delivery landed in. Mixing in a
  // per-run id keeps every seedInbox()/seedJunk() call's Message-IDs unique
  // so retries always actually (re-)deliver.
  const baseHeaders = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${date}`,
    `Message-ID: <${runId}.${message.messageId}>`,
  ];

  if (message.html === undefined) {
    const headers = [...baseHeaders, "Content-Type: text/plain; charset=utf-8", "MIME-Version: 1.0"].join("\r\n");
    return `${headers}\r\n\r\n${prepareMimePart(message.body)}\r\n.\r\n`;
  }

  // HTML fixtures go out as multipart/alternative (text/plain part first,
  // text/html part second) — the same shape real marketing mail uses, and it
  // keeps a plain-text fallback available for any client that renders it.
  // Boundary is derived from the run + message id (both already unique) so
  // it needs no extra randomness; sanitized down to the token characters
  // RFC 2046 allows unescaped in a boundary parameter.
  const boundary = `seed-${runId}-${message.messageId}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const headers = [
    ...baseHeaders,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "MIME-Version: 1.0",
  ].join("\r\n");
  const textPart = [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", prepareMimePart(message.body)].join(
    "\r\n",
  );
  const htmlPart = [`--${boundary}`, "Content-Type: text/html; charset=utf-8", "", prepareMimePart(message.html)].join(
    "\r\n",
  );
  return `${headers}\r\n\r\n${textPart}\r\n${htmlPart}\r\n--${boundary}--\r\n.\r\n`;
}

// Pulls the bare address out of an RFC5322 mailbox string ("Display Name
// <addr>" or just "addr") — used by seedJunk to set the envelope MAIL FROM
// to the message's own (external, unverified) sender address instead of an
// authenticated identity, which is exactly what makes Stalwart's spam filter
// classify the delivery into Junk Mail.
function extractEnvelopeAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1]! : from;
}

async function ehlo(socket: Socket, heloHost: string): Promise<void> {
  await sendCommand(socket, null); // 220 greeting
  const ehloResponse = await sendCommand(socket, `EHLO ${heloHost}`);
  if (ehloResponse.code !== 250) {
    throw new Error(`EHLO rejected: ${ehloResponse.code} ${ehloResponse.text}`);
  }
}

async function authLogin(socket: Socket, email: string, password: string): Promise<void> {
  const authStart = await sendCommand(socket, "AUTH LOGIN");
  if (authStart.code !== 334) {
    throw new Error(`AUTH LOGIN not offered: ${authStart.code} ${authStart.text}`);
  }
  const userPrompt = await sendCommand(socket, Buffer.from(email, "utf8").toString("base64"));
  if (userPrompt.code !== 334) {
    throw new Error(`AUTH LOGIN username rejected: ${userPrompt.code} ${userPrompt.text}`);
  }
  const authResult = await sendCommand(socket, Buffer.from(password, "utf8").toString("base64"));
  if (authResult.code !== 235) {
    throw new Error(`AUTH LOGIN password rejected: ${authResult.code} ${authResult.text}`);
  }
}

async function deliverOne(socket: Socket, message: SeedEmail, envelopeFrom: string, runId: string): Promise<void> {
  const mailFrom = await sendCommand(socket, `MAIL FROM:<${envelopeFrom}>`);
  if (mailFrom.code !== 250) {
    throw new Error(`MAIL FROM rejected: ${mailFrom.code} ${mailFrom.text}`);
  }
  const rcptTo = await sendCommand(socket, `RCPT TO:<${message.to}>`);
  if (rcptTo.code !== 250) {
    throw new Error(`RCPT TO rejected: ${rcptTo.code} ${rcptTo.text}`);
  }
  const data = await sendCommand(socket, "DATA");
  if (data.code !== 354) {
    throw new Error(`DATA rejected: ${data.code} ${data.text}`);
  }
  const finalResponse = await sendRaw(socket, buildRawMessage(message, runId));
  if (finalResponse.code !== 250) {
    throw new Error(`message "${message.subject}" rejected after DATA: ${finalResponse.code} ${finalResponse.text}`);
  }
}

/**
 * Delivers `messages` into Stalwart's Inbox for the fixture's test mailbox
 * over authenticated, implicit-TLS SMTP (see the file header for why
 * authenticated submission is required rather than plain unauthenticated
 * delivery). `host`/`port` should point at Stalwart's TLS SMTP listener
 * (docker-compose.e2e.yml publishes it as localhost:8465).
 *
 * Each message is delivered in its own connection so a single dropped socket
 * only affects one seed email, not the whole batch. Connects are retried a
 * few times since Stalwart may still be starting up right after
 * `docker compose up`.
 */
export async function seedInbox(host: string, port: number, messages: SeedEmail[]): Promise<void> {
  const heloHost = "cefiro.test";
  // Baked into the e2e/stalwart fixture (see e2e/stalwart/README.md) — only
  // valid for this local/E2E fixture, never production credentials. Used
  // both to authenticate and as the required envelope MAIL FROM.
  const account = { email: "admin@cefiro.test", password: "n2BODWVsupeXnJ3L" };

  const ca = await fetchFixtureCertificate(host, port);
  const tlsOptions: ConnectionOptions = { ca, servername: STALWART_CERT_SERVERNAME };
  const runId = crypto.randomUUID();

  for (const message of messages) {
    await withConversationRetry(`seedInbox "${message.subject}"`, async () => {
      const socket = await connectWithRetry(host, port, tlsOptions);
      try {
        await ehlo(socket, heloHost);
        await authLogin(socket, account.email, account.password);
        await deliverOne(socket, message, account.email, runId);
        await sendCommand(socket, "QUIT").catch(() => undefined);
      } finally {
        socket.destroy();
      }
    });
  }
}

/**
 * Delivers `messages` into Stalwart's Junk Mail folder for the fixture's
 * test mailbox over plain, UNAUTHENTICATED SMTP (see the file header for why
 * this is the path that exercises Stalwart's real spam filter). `host`/`port`
 * should point at Stalwart's plain SMTP listener (docker-compose.e2e.yml
 * publishes it as localhost:8025).
 *
 * Unlike seedInbox, the envelope MAIL FROM here is NOT pinned to an
 * authenticated account identity — there is no AUTH step at all — it's each
 * message's own (external, unverified) sender address, extracted from its
 * RFC5322 "From" header. That's what makes the delivery look like genuine
 * inbound spam to Stalwart's classifier rather than a locally-authored
 * message, so it's classified into Junk Mail instead of forced there.
 *
 * Each message is delivered in its own connection so a single dropped socket
 * only affects one seed email, not the whole batch. Connects are retried a
 * few times since Stalwart may still be starting up right after
 * `docker compose up`.
 */
export async function seedJunk(host: string, port: number, messages: SeedEmail[]): Promise<void> {
  // Deliberately not "cefiro.test" — this path impersonates external inbound
  // mail, so it EHLOs as a plausible outside relay rather than the fixture's
  // own domain.
  const heloHost = "external-relay.test";
  const runId = crypto.randomUUID();

  for (const message of messages) {
    await withConversationRetry(`seedJunk "${message.subject}"`, async () => {
      const socket = await connectPlainWithRetry(host, port);
      try {
        await ehlo(socket, heloHost);
        await deliverOne(socket, message, extractEnvelopeAddress(message.from), runId);
        await sendCommand(socket, "QUIT").catch(() => undefined);
      } finally {
        socket.destroy();
      }
    });
  }
}
