// Tiny JMAP HTTP helper for test-fixture provisioning only (no app/server
// code involved) — used by global-setup.ts to make sure the Stalwart fixture
// account has the mailboxes the mail-actions spec needs before any test runs.

interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

interface JmapMailbox {
  id: string;
  role?: string | null;
}

async function jmapSession(stalwartUrl: string, authHeader: string): Promise<JmapSession> {
  const res = await fetch(`${stalwartUrl}/.well-known/jmap`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    throw new Error(`JMAP session fetch failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as JmapSession;
}

async function jmapCall(
  apiUrl: string,
  authHeader: string,
  methodCalls: unknown[],
): Promise<{ methodResponses: [string, Record<string, unknown>, string][] }> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    }),
  });
  if (!res.ok) {
    throw new Error(`JMAP call failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<{ methodResponses: [string, Record<string, unknown>, string][] }>;
}

/**
 * Ensures the Stalwart fixture account has a mailbox with JMAP role
 * "archive" — the app's "Archivar" action (and the Archivados view) is only
 * rendered when one exists (see MailPage.tsx's archiveMailboxId lookup), but
 * this fixture's baked-in setup-wizard account only provisions Inbox, Sent
 * Items, Drafts, Junk Mail and Deleted Items by default (confirmed via a live
 * Mailbox/get against the fixture — there is no "archive"-role mailbox out of
 * the box). Idempotent: a no-op if the mailbox already exists, so re-running
 * global-setup against an already-provisioned fixture is safe.
 */
export async function ensureArchiveMailbox(
  stalwartUrl: string,
  email: string,
  password: string,
): Promise<void> {
  const authHeader = `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
  const session = await jmapSession(stalwartUrl, authHeader);
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId) {
    throw new Error("JMAP session has no urn:ietf:params:jmap:mail primary account");
  }

  const getResult = await jmapCall(session.apiUrl, authHeader, [
    ["Mailbox/get", { accountId, properties: ["id", "role"] }, "0"],
  ]);
  const list = (getResult.methodResponses[0]?.[1]?.list ?? []) as JmapMailbox[];
  if (list.some((mailbox) => mailbox.role === "archive")) return;

  await jmapCall(session.apiUrl, authHeader, [
    [
      "Mailbox/set",
      { accountId, create: { archive: { name: "Archive", parentId: null, role: "archive" } } },
      "0",
    ],
  ]);
}
