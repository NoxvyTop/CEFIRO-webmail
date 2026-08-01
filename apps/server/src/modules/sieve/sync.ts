import type { FilterRule, VacationSettings } from "@webmail/shared";
import { DomainError } from "../../core/errors";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/stalwart/jmap";
import { generateSieveScript } from "./generator";

export const SIEVE_CAPABILITY = "urn:ietf:params:jmap:sieve";
export const MANAGED_SCRIPT_NAME = "webmail";
const DEFAULT_TRASH_FOLDER = "Trash";

/**
 * Whether this account's JMAP provider can run the Sieve scripts filters and
 * vacation are built out of (GH #36).
 *
 * `urn:ietf:params:jmap:sieve` is an extension, not part of the mail spec. This
 * server used to ASSUME it and put it in every `using` array below, so against
 * a provider without it every filter save and every vacation change failed with
 * a generic JMAP error and nothing anywhere said the feature simply does not
 * exist there. Reading the session's own advertisement is the answer the
 * protocol already provides.
 *
 * An UNKNOWN capability list — a session this client did not build, i.e. only
 * ever a test fixture — is treated as supported rather than unsupported: the
 * cost of a wrong "yes" is the error the user got before, while a wrong "no"
 * would hide a working feature. Only a positive absence disables anything.
 */
export function supportsSieve(session: JmapSession): boolean {
  return session.capabilities === undefined || session.capabilities.includes(SIEVE_CAPABILITY);
}

function assertSetSucceeded(result: Record<string, unknown>): void {
  for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
    const failures = result[key];
    if (failures && Object.keys(failures as Record<string, unknown>).length > 0) {
      throw new DomainError("sieve_sync_failed", 502, "errors.sieve_sync_failed");
    }
  }
}

export async function syncSieveScript(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  rules: FilterRule[];
  vacation: VacationSettings | null;
}): Promise<void> {
  const { jmap, auth, session } = input;
  const accountId = session.accountId;

  const mailboxResponses = await jmap.request(auth, session, [
    ["Mailbox/get", { accountId, properties: ["name", "role"] }, "0"],
  ]);
  const mailboxes =
    ((mailboxResponses[0]?.[1] ?? {}) as { list?: { name: string; role?: string | null }[] })
      .list ?? [];
  const trashFolder =
    mailboxes.find((mailbox) => mailbox.role === "trash")?.name ?? DEFAULT_TRASH_FOLDER;

  const script = generateSieveScript({
    rules: input.rules,
    vacation: input.vacation,
    trashFolder,
  });

  const getResponses = await jmap.request(
    auth,
    session,
    [["SieveScript/get", { accountId, properties: ["name"] }, "0"]],
    [SIEVE_CAPABILITY],
  );
  const scripts =
    ((getResponses[0]?.[1] ?? {}) as { list?: { id: string; name: string }[] }).list ?? [];
  const existing = scripts.find((s) => s.name === MANAGED_SCRIPT_NAME) ?? null;

  if (script === "") {
    if (existing) {
      const destroyResponses = await jmap.request(
        auth,
        session,
        [
          [
            "SieveScript/set",
            { accountId, destroy: [existing.id], onSuccessActivateScript: null },
            "0",
          ],
        ],
        [SIEVE_CAPABILITY],
      );
      assertSetSucceeded(destroyResponses[0]?.[1] ?? {});
    }
    return;
  }

  const blobId = await jmap.uploadBlob(auth, session, script, "application/sieve");

  const validateResponses = await jmap.request(
    auth,
    session,
    [["SieveScript/validate", { accountId, blobId }, "0"]],
    [SIEVE_CAPABILITY],
  );
  const validateResult = (validateResponses[0]?.[1] ?? {}) as { error?: unknown };
  if (validateResult.error != null) {
    throw new DomainError("sieve_invalid", 502, "errors.sieve_invalid");
  }

  const setArgs = existing
    ? { accountId, update: { [existing.id]: { blobId } }, onSuccessActivateScript: existing.id }
    : {
        accountId,
        create: { webmailScript: { name: MANAGED_SCRIPT_NAME, blobId } },
        onSuccessActivateScript: "#webmailScript",
      };
  const setResponses = await jmap.request(
    auth,
    session,
    [["SieveScript/set", setArgs, "0"]],
    [SIEVE_CAPABILITY],
  );
  assertSetSucceeded(setResponses[0]?.[1] ?? {});
}
