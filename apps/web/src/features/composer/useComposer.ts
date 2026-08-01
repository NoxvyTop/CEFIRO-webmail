import type { SaveDraftInput, SendEmailInput } from "@webmail/shared";
import { useEffect, useReducer, useRef } from "react";
import { saveDraft as saveDraftRequest, sendEmail, uploadAttachment } from "./api";
import { fetchAiDraft } from "./aiApi";
import { isComposerDraftEmpty } from "./emptiness";
import { MailApiError, updateMessage } from "../mailbox/api";
import { errorMessageKey } from "../../app/errorMessages";
import type { ComposerDraft } from "./reply";
import { stripSignatureMarkers } from "./signature";

export type Attachment = { blobId: string; name: string; type: string; size: number };
export type PendingUpload = { id: string; name: string; size: number; progress: number; error: boolean };

// GH #178: the idle window before an in-progress compose is autosaved. Long
// enough that ordinary typing never triggers a save mid-word (the timer is
// reset on every keystroke), short enough that an accidental close or crash
// loses at most a second or two of work.
export const AUTOSAVE_DEBOUNCE_MS = 1500;

// The autosave indicator's user-visible state (GH #178). "idle" renders
// nothing at all — a brand-new, untouched composer must not show a status.
export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export type ComposerState = {
  draft: ComposerDraft;
  attachments: Attachment[];
  uploads: PendingUpload[];
  sending: boolean;
  sendError: string | null;
  // GH #125: mirrors sending/sendError, but for the "Save to drafts" action
  // offered by the Escape-to-close discard confirmation.
  savingDraft: boolean;
  saveDraftError: string | null;
  // GH #178: drives the subtle autosave indicator. Independent of
  // savingDraft/saveDraftError above, which belong to the explicit "Save to
  // drafts" button in the discard confirmation — the two run through the same
  // save pipeline but surface in different places and must not clobber each
  // other's UI.
  autosaveStatus: AutosaveStatus;
  aiDrafting: boolean;
  aiDraftError: string | null;
  aiDraftNotice: boolean;
  aiUnavailable: boolean;
};

type Action =
  | { type: "setField"; key: keyof ComposerDraft; value: unknown }
  | { type: "addPendingUpload"; upload: PendingUpload }
  | { type: "setUploadProgress"; id: string; progress: number }
  | { type: "uploadSucceeded"; id: string; attachment: Attachment }
  | { type: "uploadFailed"; id: string }
  | { type: "removeAttachment"; blobId: string }
  | { type: "sendStart" }
  | { type: "sendFailed"; error: string }
  | { type: "sendSucceeded" }
  | { type: "saveDraftStart" }
  | { type: "saveDraftFailed"; error: string }
  | { type: "saveDraftSucceeded" }
  | { type: "autosaveStart" }
  | { type: "autosaveSaved" }
  | { type: "autosaveError" }
  | { type: "aiDraftStart" }
  | { type: "aiDraftNeedsSubject" }
  | { type: "aiDraftSucceeded"; bodyHtml: string }
  | { type: "aiDraftFailed"; error: string | null; unavailable: boolean };

function reducer(state: ComposerState, action: Action): ComposerState {
  switch (action.type) {
    case "setField":
      return { ...state, draft: { ...state.draft, [action.key]: action.value } };
    case "addPendingUpload":
      return { ...state, uploads: [...state.uploads, action.upload] };
    case "setUploadProgress":
      return {
        ...state,
        uploads: state.uploads.map((upload) =>
          upload.id === action.id ? { ...upload, progress: action.progress } : upload,
        ),
      };
    case "uploadSucceeded":
      return {
        ...state,
        attachments: [...state.attachments, action.attachment],
        uploads: state.uploads.filter((upload) => upload.id !== action.id),
      };
    case "uploadFailed":
      return {
        ...state,
        uploads: state.uploads.map((upload) =>
          upload.id === action.id ? { ...upload, error: true } : upload,
        ),
      };
    case "removeAttachment":
      return {
        ...state,
        attachments: state.attachments.filter((attachment) => attachment.blobId !== action.blobId),
      };
    case "sendStart":
      return { ...state, sending: true, sendError: null };
    case "sendFailed":
      return { ...state, sending: false, sendError: action.error };
    case "sendSucceeded":
      return { ...state, sending: false, sendError: null };
    case "saveDraftStart":
      return { ...state, savingDraft: true, saveDraftError: null };
    case "saveDraftFailed":
      return { ...state, savingDraft: false, saveDraftError: action.error };
    case "saveDraftSucceeded":
      return { ...state, savingDraft: false, saveDraftError: null };
    case "autosaveStart":
      return { ...state, autosaveStatus: "saving" };
    case "autosaveSaved":
      return { ...state, autosaveStatus: "saved" };
    case "autosaveError":
      return { ...state, autosaveStatus: "error" };
    case "aiDraftStart":
      return { ...state, aiDrafting: true, aiDraftError: null, aiDraftNotice: false };
    case "aiDraftNeedsSubject":
      return { ...state, aiDraftError: "composer.aiDraftNeedsSubject" };
    case "aiDraftSucceeded":
      return {
        ...state,
        aiDrafting: false,
        aiDraftError: null,
        aiDraftNotice: true,
        draft: { ...state.draft, bodyHtml: action.bodyHtml },
      };
    case "aiDraftFailed":
      return { ...state, aiDrafting: false, aiDraftError: action.error, aiUnavailable: action.unavailable };
    default:
      return state;
  }
}

function initState(draft: ComposerDraft): ComposerState {
  return {
    draft,
    attachments: draft.attachments ?? [],
    uploads: [],
    sending: false,
    sendError: null,
    savingDraft: false,
    saveDraftError: null,
    autosaveStatus: "idle",
    aiDrafting: false,
    aiDraftError: null,
    aiDraftNotice: false,
    aiUnavailable: false,
  };
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();
}

// Shared by send() and saveDraft() (GH #125): both submit the same compose
// fields (identity, recipients, subject, body, attachments, threading
// headers) to structurally identical schemas (see
// packages/shared/src/api/compose.ts's composeEmailFieldsSchema) — saveDraft
// additionally carries originalDraftId, layered on by its own caller below.
//
// stripMarkers controls whether the composer's internal signature/quote
// marker divs (see composer/signature.ts) are stripped from the body:
//
//   - send() passes true. A recipient (or another mail client) must never
//     see this app's internal bookkeeping markup.
//   - saveDraft() passes false (GH #156). Stripping the marker here used to
//     be the root cause of a reopened draft's signature duplicating: with
//     the marker gone, reply.ts's buildEditDraft had no way to recognize
//     the previously-applied signature on reopen, so the next auto-apply
//     (Composer.tsx) appended a second, unmarked copy instead of finding
//     and replacing the first via applySignature's marker-based lookup. A
//     saved draft is never recipient-facing — it only round-trips back
//     through this same app — so keeping the marker costs nothing and lets
//     every later apply/switch/remove cycle stay a clean in-place replace.
function buildComposePayload(
  draft: ComposerDraft,
  attachments: Attachment[],
  options: { stripMarkers: boolean },
): SendEmailInput {
  const outgoingBodyHtml = options.stripMarkers ? stripSignatureMarkers(draft.bodyHtml) : draft.bodyHtml;

  return {
    identityId: draft.identityId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    textBody: htmlToPlainText(outgoingBodyHtml),
    htmlBody: outgoingBodyHtml,
    attachments: attachments.map((attachment) => ({
      blobId: attachment.blobId, name: attachment.name, type: attachment.type,
    })),
    inReplyTo: draft.inReplyTo,
    references: draft.references,
  };
}

// GH #178: a stable fingerprint of everything a saved draft persists, used to
// tell "the content actually changed" from "React re-rendered". Autosave skips
// a save whenever this matches what was last persisted, so returning the body
// to an already-saved state, or a re-render that touches no compose field,
// never fires a redundant save. Built from the same payload the save sends
// (markers kept, exactly as saveDraft persists them) so the two cannot drift.
function serializeDraftPayload(draft: ComposerDraft, attachments: Attachment[]): string {
  return JSON.stringify(buildComposePayload(draft, attachments, { stripMarkers: false }));
}

export function useComposer(
  initial: ComposerDraft,
  // Present when editing an existing draft (compose=draft:<id>, see
  // reply.ts's buildEditDraft) and a Trash mailbox exists — lets send()
  // clean up the stale original draft after a successful send (Gmail: the
  // draft you sent stops lingering in Borradores).
  trashMailboxId?: string | null,
): {
  state: ComposerState;
  setField<K extends keyof ComposerDraft>(key: K, value: ComposerDraft[K]): void;
  addFiles(files: File[]): { skipped: string[] };
  removeAttachment(blobId: string): void;
  send(): Promise<boolean>;
  saveDraft(): Promise<boolean>;
  discardDraft(): void;
  draftWithAi(): Promise<void>;
} {
  const [state, dispatch] = useReducer(reducer, initial, initState);

  // Always-current mirror of state for the async save pipeline. Autosave runs
  // out of a debounce timer and can re-run after an await (see the coalescing
  // loop below), so it must read the latest draft/attachments at the moment it
  // actually saves — not the values captured when a timer was scheduled.
  // Written during render (a ref write, not a state update) so it is in place
  // before any effect or timer callback fires.
  const stateRef = useRef(state);
  stateRef.current = state;

  // The id of the draft this compose session currently owns server-side.
  // Seeded from initial.originalDraftId when reopening an existing draft, then
  // advanced to the id every successful save returns. GH #178: POST /drafts is
  // create-then-replace, not update (RFC 8620 §5.3 — Email/set create+update
  // aren't transactional), so each save passes this as originalDraftId to make
  // the server supersede the previous copy instead of leaving a duplicate.
  const currentDraftIdRef = useRef<string | undefined>(initial.originalDraftId);

  // Single-save-in-flight lock shared by autosave and the explicit "Save to
  // drafts" action. GH #178: overlapping saves could create two drafts, or
  // trash the copy that was just created, so only one save is ever in flight;
  // a save requested while one runs is coalesced into pendingSaveRef and picked
  // up by the loop below once the current save settles, always with the latest
  // content. This also preserves GH #125's re-entrancy guard for saveDraft().
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);

  // Fingerprint of the last successfully persisted payload. Seeded from the
  // initial draft so reopening an existing draft doesn't autosave an unchanged
  // copy on open, and advanced on every save so identical content is never
  // saved twice.
  const lastSavedPayloadRef = useRef<string>(
    serializeDraftPayload(initial, initial.attachments ?? []),
  );

  // Set once the compose session is closing on purpose — a successful send, or
  // an explicit "Discard anyway" (see discardDraft()). The unmount flush below
  // (GH #176) exists only for a *silent* teardown (navigating away via the home
  // link); a deliberate close must never resurrect the message as a draft after
  // it was sent, or re-save one the user just chose to throw away.
  const finalizedRef = useRef(false);

  function setField<K extends keyof ComposerDraft>(key: K, value: ComposerDraft[K]): void {
    dispatch({ type: "setField", key, value });
  }

  // Autosave's emptiness gate. Unlike the close/discard rule (which counts an
  // in-flight upload as content worth confirming — see emptiness.ts), autosave
  // ignores pending uploads: they have no blobId yet, so nothing about them is
  // persistable. When the upload resolves it becomes a real attachment and the
  // debounce fires again on that change.
  function isAutosavableEmpty(): boolean {
    const { draft, attachments } = stateRef.current;
    return isComposerDraftEmpty(draft, attachments.length, 0);
  }

  // One save round-trip against the current content. No dispatch of its own so
  // it is safe to call from an unmount cleanup (see below), where setting state
  // would warn. Advances the owned draft id and the saved-payload fingerprint
  // so the next save supersedes this copy instead of duplicating it.
  async function persistDraft(): Promise<void> {
    const { draft, attachments } = stateRef.current;
    const payload = buildComposePayload(draft, attachments, { stripMarkers: false });
    const snapshot = JSON.stringify(payload);
    const input: SaveDraftInput = { ...payload, originalDraftId: currentDraftIdRef.current };
    const result = await saveDraftRequest(input);
    currentDraftIdRef.current = result.id;
    lastSavedPayloadRef.current = snapshot;
  }

  async function autosave(): Promise<void> {
    if (isAutosavableEmpty()) return;
    const { draft, attachments } = stateRef.current;
    if (serializeDraftPayload(draft, attachments) === lastSavedPayloadRef.current) return;
    // A save is already running: record that more content arrived so exactly
    // one more save runs after it, instead of racing a second one now.
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    saveInFlightRef.current = true;
    dispatch({ type: "autosaveStart" });
    try {
      pendingSaveRef.current = false;
      await persistDraft();
      // Drain edits that landed while the save above was in flight — but only
      // while there is genuinely newer, non-empty content, so this settles
      // instead of looping on unchanged state.
      while (
        pendingSaveRef.current &&
        !isAutosavableEmpty() &&
        serializeDraftPayload(stateRef.current.draft, stateRef.current.attachments) !==
          lastSavedPayloadRef.current
      ) {
        pendingSaveRef.current = false;
        await persistDraft();
      }
      dispatch({ type: "autosaveSaved" });
    } catch {
      dispatch({ type: "autosaveError" });
    } finally {
      saveInFlightRef.current = false;
    }
  }

  // Debounced autosave (GH #178). Reschedules on every meaningful change and
  // never schedules for empty or already-saved content, so plain re-renders
  // and the default-signature auto-apply on an untouched draft cost nothing.
  useEffect(() => {
    if (isAutosavableEmpty()) return;
    if (
      serializeDraftPayload(stateRef.current.draft, stateRef.current.attachments) ===
      lastSavedPayloadRef.current
    ) {
      return;
    }
    const timer = setTimeout(() => void autosave(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the persisted compose fields; autosave/helpers read the latest via stateRef
  }, [
    state.draft.identityId,
    state.draft.to,
    state.draft.cc,
    state.draft.bcc,
    state.draft.subject,
    state.draft.bodyHtml,
    state.attachments,
  ]);

  // GH #176: the composer can be torn down by a route change that never runs
  // through requestClose — most notably the header's CÉFIRO home link, which
  // clears the `compose` param and unmounts the composer. Flush any content
  // not yet persisted so navigating away can't silently drop the draft. Empty
  // deps: this cleanup runs only on unmount, and everything it touches is a
  // ref or the live stateRef, so the first-render closure still sees the
  // latest content.
  useEffect(() => {
    return () => {
      // A deliberate close (sent, or discarded) already decided the draft's
      // fate — don't second-guess it by flushing on the way out.
      if (finalizedRef.current) return;
      if (isAutosavableEmpty()) return;
      if (
        serializeDraftPayload(stateRef.current.draft, stateRef.current.attachments) ===
        lastSavedPayloadRef.current
      ) {
        return;
      }
      // A save is mid-flight: let its coalescing loop pick up the latest rather
      // than firing a second, overlapping request as we tear down.
      if (saveInFlightRef.current) {
        pendingSaveRef.current = true;
        return;
      }
      // Fire-and-forget: the component is going away, so there is nothing to
      // await into and no state left to update — best-effort by design.
      void persistDraft().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only flush; reads the latest content via refs
  }, []);

  // Cheap, reliable dedup heuristic: name+size. Checked against both
  // already-uploaded attachments and still-pending uploads, and against
  // files already accepted earlier in the *same* addFiles call (so
  // selecting/dropping the same file twice at once is also caught).
  function fileSignature(name: string, size: number): string {
    return `${name}␟${size}`;
  }

  function addFiles(files: File[]): { skipped: string[] } {
    const seen = new Set<string>();
    for (const attachment of state.attachments) seen.add(fileSignature(attachment.name, attachment.size));
    for (const upload of state.uploads) seen.add(fileSignature(upload.name, upload.size));

    const skipped: string[] = [];

    for (const file of files) {
      const signature = fileSignature(file.name, file.size);
      if (seen.has(signature)) {
        skipped.push(file.name);
        continue;
      }
      seen.add(signature);

      const id = crypto.randomUUID();
      dispatch({
        type: "addPendingUpload",
        upload: { id, name: file.name, size: file.size, progress: 0, error: false },
      });

      uploadAttachment(file, (fraction) => {
        dispatch({ type: "setUploadProgress", id, progress: fraction });
      })
        .then((result) => {
          dispatch({
            type: "uploadSucceeded",
            id,
            attachment: { blobId: result.blobId, name: file.name, type: result.type, size: result.size },
          });
        })
        .catch(() => {
          dispatch({ type: "uploadFailed", id });
        });
    }

    return { skipped };
  }

  function removeAttachment(blobId: string): void {
    dispatch({ type: "removeAttachment", blobId });
  }

  async function send(): Promise<boolean> {
    const { draft, attachments } = state;
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      dispatch({ type: "sendFailed", error: "composer.errors.noRecipients" });
      return false;
    }

    const input = buildComposePayload(draft, attachments, { stripMarkers: true });

    dispatch({ type: "sendStart" });
    try {
      await sendEmail(input);
      // Best-effort cleanup: the send already succeeded (it's in Sent now),
      // so a failure to trash the stale draft must not surface as a send
      // failure — the user just keeps a leftover draft, same as today's
      // behavior without this feature.
      //
      // GH #178: this targets currentDraftIdRef, not draft.originalDraftId.
      // The two are the same when reopening an existing draft that was never
      // autosaved, but autosave advances currentDraftIdRef to the copy it
      // created (even for a brand-new email that had no originalDraftId), and
      // that copy is the one now sitting in Drafts. Trashing it on send is
      // what stops an autosaved draft lingering after the mail is sent.
      const draftToTrash = currentDraftIdRef.current;
      if (draftToTrash && trashMailboxId) {
        try {
          await updateMessage(draftToTrash, { mailboxIds: { [trashMailboxId]: true } });
        } catch {
          // ignore — see comment above
        }
      }
      // The message left as mail, not a draft: block the unmount flush so the
      // onClose that follows a successful send can't recreate it as a draft.
      finalizedRef.current = true;
      dispatch({ type: "sendSucceeded" });
      return true;
    } catch (err) {
      // GH #215: resolved through the one shared code -> key map instead of
      // interpolating the raw server code into a key that may not exist.
      const error = errorMessageKey("composer", err instanceof MailApiError ? err.code : null);
      dispatch({ type: "sendFailed", error });
      return false;
    }
  }

  // GH #176: called by the composer's "Discard anyway" path so the deliberate
  // teardown that follows doesn't trip the unmount flush and re-save the very
  // draft the user just chose to abandon. Any copy an earlier autosave already
  // wrote stays in Drafts (recoverable) — discard suppresses the flush, it does
  // not chase down and delete an already-persisted draft.
  function discardDraft(): void {
    finalizedRef.current = true;
  }

  // GH #125: "Save to drafts" from the Escape-to-close discard confirmation.
  // Unlike send(), a draft is deliberately allowed to be incomplete — no
  // recipient/subject guard here (see packages/shared/src/api/compose.ts's
  // saveDraftSchema, GH #149) — and originalDraftId is layered onto the
  // shared payload so saving an already-open draft replaces it server-side
  // instead of creating a duplicate.
  async function saveDraft(): Promise<boolean> {
    // Shares saveInFlightRef with autosave (GH #178): still the synchronous
    // re-entrancy guard GH #125 introduced (a double-click can't fire two
    // saves), and now also keeps this explicit save from overlapping an
    // in-flight autosave. Routes through the same persistDraft, so it advances
    // the owned draft id and supersedes the autosaved copy rather than
    // creating a duplicate.
    if (saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    // We are persisting the latest content right now, so a queued autosave
    // would be redundant.
    pendingSaveRef.current = false;
    dispatch({ type: "saveDraftStart" });
    try {
      await persistDraft();
      dispatch({ type: "saveDraftSucceeded" });
      // Keep the ambient indicator consistent with the discard dialog's own
      // button state — the draft genuinely is saved now.
      dispatch({ type: "autosaveSaved" });
      return true;
    } catch (err) {
      // GH #215: resolved through the one shared code -> key map instead of
      // interpolating the raw server code into a key that may not exist.
      const error = errorMessageKey("composer", err instanceof MailApiError ? err.code : null);
      dispatch({ type: "saveDraftFailed", error });
      return false;
    } finally {
      saveInFlightRef.current = false;
    }
  }

  // Requires a subject before hitting the endpoint at all — matches the design
  // spec ("requiere asunto, si no, aviso") and avoids a pointless network call.
  async function draftWithAi(): Promise<void> {
    if (!state.draft.subject.trim()) {
      dispatch({ type: "aiDraftNeedsSubject" });
      return;
    }
    dispatch({ type: "aiDraftStart" });
    try {
      const body = await fetchAiDraft(state.draft.subject);
      dispatch({ type: "aiDraftSucceeded", bodyHtml: `<p>${body}</p>` });
    } catch (err) {
      if (err instanceof MailApiError && err.code === "ai_disabled") {
        // Software-level gate is off — hide the feature rather than showing
        // a broken/error button (see docs/ARCHITECTURE.md, AI opt-in gate).
        dispatch({ type: "aiDraftFailed", error: null, unavailable: true });
        return;
      }
      const error = errorMessageKey("composer", err instanceof MailApiError ? err.code : null);
      dispatch({ type: "aiDraftFailed", error, unavailable: false });
    }
  }

  return { state, setField, addFiles, removeAttachment, send, saveDraft, discardDraft, draftWithAi };
}
