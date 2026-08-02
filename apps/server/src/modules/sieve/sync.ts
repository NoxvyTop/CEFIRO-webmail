import type { FilterRule, SieveRawScript, VacationSettings } from "@webmail/shared";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/jmap/client";
import { generateSieveScript } from "./generator";

export const SIEVE_CAPABILITY = "urn:ietf:params:jmap:sieve";
export const MANAGED_SCRIPT_NAME = "webmail";
/**
 * What a `delete` action files into when the provider lists no trash mailbox —
 * and, for the advanced editor's preview (GH #23), when the provider cannot be
 * reached to be asked at all.
 */
export const DEFAULT_TRASH_FOLDER = "Trash";

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

/**
 * The name of this account's trash mailbox, which is the folder a `delete`
 * action files into. Asked of the provider rather than assumed, because the
 * role is standard and the NAME is not ("Papelera", "Deleted Items", …).
 *
 * Exported for the advanced editor (GH #23): the preview it seeds a hand-over
 * from has to be the script that would actually be pushed, and a preview that
 * said `fileinto "Trash"` where the real push says `fileinto "Papelera"` would
 * hand the user a subtly wrong starting point.
 */
export async function resolveTrashFolder(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
}): Promise<string> {
  const { jmap, auth, session } = input;
  const responses = await jmap.request(auth, session, [
    ["Mailbox/get", { accountId: session.accountId, properties: ["name", "role"] }, "0"],
  ]);
  const mailboxes =
    ((responses[0]?.[1] ?? {}) as { list?: { name: string; role?: string | null }[] }).list ?? [];
  return mailboxes.find((mailbox) => mailbox.role === "trash")?.name ?? DEFAULT_TRASH_FOLDER;
}

/**
 * Uploads a script and asks the provider's own parser to accept it, returning
 * the blob id the caller can then activate.
 *
 * `SieveScript/validate` (RFC 9661 §3.2) is JMAP's CHECKSCRIPT (RFC 5804
 * §2.12): the only authority on whether a script this server did not generate
 * will run. Exported so the advanced editor (GH #23) can ask BEFORE storing a
 * hand-written script, rather than storing a script that cannot work and
 * leaving the account parked on `sieve_invalid` — the one sync failure the
 * model in GH #221 marks as never worth retrying.
 */
export async function uploadAndValidateScript(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  script: string;
}): Promise<string> {
  const { jmap, auth, session } = input;
  const blobId = await jmap.uploadBlob(auth, session, input.script, "application/sieve");
  const responses = await jmap.request(
    auth,
    session,
    [["SieveScript/validate", { accountId: session.accountId, blobId }, "0"]],
    [SIEVE_CAPABILITY],
  );
  const error = ((responses[0]?.[1] ?? {}) as { error?: unknown }).error;
  if (error != null) {
    // The provider's own diagnostic is the only thing that can say WHY, and it
    // does not reach the user: the ApiError envelope carries a code, not a
    // message from a third party. Logged with its SetError `type` so an
    // operator asked "why was my script refused" has something to answer with.
    log("warn", "sieve script rejected by provider", {
      type: typeof error === "object" && error !== null ? String((error as { type?: unknown }).type) : "unknown",
    });
    throw new DomainError("sieve_invalid", 502, "errors.sieve_invalid");
  }
  return blobId;
}

export async function syncSieveScript(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  rules: FilterRule[];
  vacation: VacationSettings | null;
  /**
   * The account's advanced-mode state (GH #23). When it says `raw`, the
   * hand-written script is pushed VERBATIM and nothing is generated — so the
   * rules and vacation settings above, which stay stored and editable, stop
   * being applied until the user hands ownership back.
   *
   * Absent means rule-builder mode, which is what every caller predating this
   * meant and what a fresh account is.
   */
  raw?: SieveRawScript | null;
}): Promise<void> {
  const { jmap, auth, session } = input;
  const accountId = session.accountId;

  // Note the Mailbox/get is inside the generated branch: a hand-written script
  // needs no folder name resolved, so raw mode costs one JMAP call less rather
  // than one more.
  const script =
    input.raw?.mode === "raw"
      ? input.raw.script
      : generateSieveScript({
          rules: input.rules,
          vacation: input.vacation,
          trashFolder: await resolveTrashFolder({ jmap, auth, session }),
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

  const blobId = await uploadAndValidateScript({ jmap, auth, session, script });

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
