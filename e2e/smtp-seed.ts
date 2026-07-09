import { connect as connectTls, type ConnectionOptions, type TLSSocket } from "node:tls";

// Minimal SMTP client over implicit TLS ("SMTPS") — no new dependency, just
// enough of the protocol to inject inbound mail into the Stalwart fixture's
// admin@cefiro.test mailbox for E2E seeding.
//
// Why TLS + AUTH LOGIN instead of plain, unauthenticated delivery on port 25:
// unauthenticated MAIL FROM/RCPT TO on port 25 IS accepted (250 on both, no
// AUTH required for local delivery) — but Stalwart's spam filter still runs
// on that unauthenticated path and reliably classifies mail from an
// external, unverified sender domain (no SPF/DKIM) straight into "Junk Mail"
// instead of "Inbox" (confirmed against the running fixture via a JMAP
// Mailbox/Email/get round trip). Since the mail-connect spec needs the
// seeded messages visible in the Inbox the app shows by default, this client
// authenticates instead: Stalwart skips spam classification for an
// authenticated session, which reliably lands the mail in Inbox. AUTH itself
// is only offered over TLS (a plaintext "AUTH LOGIN" on port 25 gets
// "503 5.5.1 AUTH not allowed"), hence implicit TLS on port 465
// (docker-compose.e2e.yml publishes it as 8465:465) rather than plain 8025.
// Authenticated submission also requires the envelope MAIL FROM to match the
// authenticated identity ("501 5.5.4 You are not allowed to send from this
// address" otherwise) — so MAIL FROM uses the Stalwart account's own address
// while each message's RFC5322 "From" header keeps the distinct fixture
// sender, which is what the reading pane actually displays.

export interface SeedEmail {
  /** RFC5322 From header value, e.g. "Carla Ibarra <carla@partner.test>". */
  from: string;
  /** Envelope + header recipient, e.g. "admin@cefiro.test". */
  to: string;
  subject: string;
  body: string;
  /** Local-part of the Message-ID, made unique per test run by seedInbox. */
  messageId: string;
}

interface SmtpResponse {
  code: number;
  text: string;
}

const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 750;
const CONNECT_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// as opposed to a continuation line like "250-STARTTLS".
function readResponse(socket: TLSSocket): Promise<SmtpResponse> {
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
function sendCommand(socket: TLSSocket, command: string | null): Promise<SmtpResponse> {
  const response = readResponse(socket);
  if (command !== null) socket.write(`${command}\r\n`);
  return response;
}

// Like sendCommand, but writes a raw, already CRLF-terminated payload
// verbatim (no extra "\r\n" appended) — used for the DATA block, which
// already ends with the "\r\n.\r\n" end-of-data terminator built by
// buildRawMessage. Appending another "\r\n" after that terminator would send
// a stray empty line the server reads as a new (invalid) command.
function sendRaw(socket: TLSSocket, payload: string): Promise<SmtpResponse> {
  const response = readResponse(socket);
  socket.write(payload);
  return response;
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
  // per-run id keeps every seedInbox() call's Message-IDs unique so retries
  // always actually (re-)deliver.
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${date}`,
    `Message-ID: <${runId}.${message.messageId}>`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ].join("\r\n");
  // Dot-stuff any body line that starts with "." per RFC 5321 §4.5.2, so an
  // accidental leading dot in a fixture body can't be mistaken for the
  // end-of-DATA terminator.
  const stuffedBody = message.body
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return `${headers}\r\n\r\n${stuffedBody}\r\n.\r\n`;
}

async function ehlo(socket: TLSSocket, heloHost: string): Promise<void> {
  await sendCommand(socket, null); // 220 greeting
  const ehloResponse = await sendCommand(socket, `EHLO ${heloHost}`);
  if (ehloResponse.code !== 250) {
    throw new Error(`EHLO rejected: ${ehloResponse.code} ${ehloResponse.text}`);
  }
}

async function authLogin(socket: TLSSocket, email: string, password: string): Promise<void> {
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

async function deliverOne(socket: TLSSocket, message: SeedEmail, envelopeFrom: string, runId: string): Promise<void> {
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
  const tlsOptions: ConnectionOptions = { ca };
  const runId = crypto.randomUUID();

  for (const message of messages) {
    const socket = await connectWithRetry(host, port, tlsOptions);
    try {
      await ehlo(socket, heloHost);
      await authLogin(socket, account.email, account.password);
      await deliverOne(socket, message, account.email, runId);
      await sendCommand(socket, "QUIT").catch(() => undefined);
    } finally {
      socket.destroy();
    }
  }
}
