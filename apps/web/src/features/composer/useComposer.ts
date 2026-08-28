import { DRAFT_CONTEXT_MAX_CHARS, type SaveDraftInput, type SendEmailInput } from "@webmail/shared";
import { useEffect, useReducer, useRef } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { saveDraft as saveDraftRequest, sendEmail, uploadAttachment } from "./api";
import { fetchAiDraft } from "./aiApi";
import { isComposerDraftEmpty } from "./emptiness";
import { MailApiError, updateMessage } from "../mailbox/api";
import { EMAIL_QUERY_KEYS, MAILBOX_QUERY_KEYS } from "../mailbox/useMailEvents";
import { errorMessageKey } from "../../app/errorMessages";
import { composeTextBody, htmlToPlainText } from "./plainText";
import { joinQuotedTail, splitQuotedTail } from "./quoteSplit";
import type { ComposerDraft } from "./reply";
import { SIGNATURE_MARKER_ATTR, stripSignatureMarkers } from "./signature";

export type Attachment = { blobId: string; name: string; type: string; size: number };
export type PendingUpload = {
  id: string;
  name: string;
  size: number;
  progress: number;
  error: boolean;
  // GH #344(b): the server's MailApiError code for a failed upload (null for
  // a client-side/network failure with no server code at all), so the error
  // card can resolve the real message — a 413 shows payload_too_large instead
  // of the generic fallback every failure used to render as.
  errorCode: string | null;
  // GH #344(b): kept so a failed upload can be retried without asking the
  // user to reselect the file — retryUpload() below re-issues the exact same
  // upload against this reference.
  file: File;
};

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
  | { type: "uploadFailed"; id: string; code: string | null }
  | { type: "uploadRetryStart"; id: string }
  | { type: "removePendingUpload"; id: string }
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
  | { type: "aiDraftNeedsIntent" }
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
          upload.id === action.id ? { ...upload, error: true, errorCode: action.code } : upload,
        ),
      };
    case "uploadRetryStart":
      // GH #344(b): back to a live, non-error pending state immediately —
      // the retry card must not keep showing the stale error while the new
      // attempt is in flight.
      return {
        ...state,
        uploads: state.uploads.map((upload) =>
          upload.id === action.id
            ? { ...upload, error: false, errorCode: null, progress: 0 }
            : upload,
        ),
      };
    case "removePendingUpload":
      return {
        ...state,
        uploads: state.uploads.filter((upload) => upload.id !== action.id),
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
    case "aiDraftNeedsIntent":
      // GH #304: subject is no longer required — the body IS the intent, so this
      // fires when the user hasn't typed anything to expand into a draft.
      return { ...state, aiDraftError: "composer.aiDraftNeedsIntent", aiDraftNotice: false };
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

// GH #336: Sent/Drafts and the sidebar's unread counters used to refresh only
// through the SSE stream (useMailEvents.ts's StateChange handler) or the
// browser's default refetchOnWindowFocus — invisible whenever a tab is over
// the per-user stream cap (429, see MailPage.tsx) or the stream otherwise
// fails to deliver. Every other mutating path in this app already invalidates
// on its own success (see reader/ThreadView.tsx's starMutation); send() and
// persistDraft() were the two exceptions. Reuses the exact same query keys
// useMailEvents derives a StateChange into, so a manual send/save and a real
// server push refresh exactly the same data.
function invalidateMailData(queryClient: QueryClient): void {
  for (const queryKey of [...EMAIL_QUERY_KEYS, ...MAILBOX_QUERY_KEYS]) {
    queryClient.invalidateQueries({ queryKey });
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
    // GH #141: derived from draft.bodyHtml, NOT from outgoingBodyHtml. The
    // quote marker composeTextBody keys on to find the quoted original is one
    // of the very markers stripMarkers removes, so building the text
    // alternative from the stripped HTML would leave the quote unmarked —
    // exactly the bug. Both alternatives still describe the same message: the
    // marker is an attribute on a wrapper div, so dropping it changes no text.
    textBody: composeTextBody(draft.bodyHtml),
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
// never fires a redundant save.
//
// It covers the same fields buildComposePayload sends, minus textBody, which is
// a pure function of bodyHtml and so adds no information the fingerprint does
// not already carry. Excluding it matters since GH #141: deriving textBody
// means a full DOMParser pass over the body, and this runs on the change-
// detection path — the guard in the debounce effect, the guard in the unmount
// flush, and again inside autosave's coalescing loop — where the payload is
// usually being built only to be compared and thrown away. persistDraft
// fingerprints through this same function, so what is compared and what is
// stored cannot drift.
function serializeDraftPayload(draft: ComposerDraft, attachments: Attachment[]): string {
  return JSON.stringify({
    identityId: draft.identityId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    attachments,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
  });
}

// GH #299: the original message body for an AI reply draft. The composer keeps
// the message being replied to as the quoted tail of the body (see reply.ts's
// quotedBody, marked with QUOTE_MARKER_ATTR), so the original text is recovered
// by splitting that tail off and flattening it to plain text. A brand-new
// compose has no quoted tail, so this returns undefined and the draft request
// carries no context — the previous behavior. Capped to the same bound the
// server enforces (DRAFT_CONTEXT_MAX_CHARS) so an over-long thread never blows
// past the schema and gets the whole request rejected.
function extractReplyContext(draft: ComposerDraft): string | undefined {
  const { quoted } = splitQuotedTail(draft.bodyHtml);
  if (!quoted) return undefined;
  const text = htmlToPlainText(quoted).trim();
  if (!text) return undefined;
  return text.slice(0, DRAFT_CONTEXT_MAX_CHARS);
}

// GH #304: the AI draft is driven by the INTENT the user types in the body, not
// the subject. The intent is what the user actually authored: the editable
// region (splitQuotedTail drops the quoted reply tail), minus the auto-applied
// signature block (machine-inserted, never something the user typed as their
// intent — same reasoning as isComposerBodyEmpty), flattened to plain text.
// Empty (nothing typed) means there is no intent to expand, so draftWithAi
// prompts the user instead of calling the API.
function extractDraftIntent(editable: string): string {
  const doc = new DOMParser().parseFromString(editable, "text/html");
  doc.body.querySelectorAll(`[${SIGNATURE_MARKER_ATTR}]`).forEach((marker) => {
    marker.remove();
  });
  return htmlToPlainText(doc.body.innerHTML).trim();
}

// GH #344(e): escapes the five ASCII characters that are ever structurally
// significant when interpolated into an HTML source string — the same set
// DOMPurify/browsers treat as needing escaping in text content and
// attribute values. Used below so plain text the AI provider returns can
// never be parsed back as markup once it lands in the composer's body.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GH #344(e): the AI provider returns plain text with `\n` line breaks, and
// the draft used to be injected verbatim as `<p>${body}</p>` — unescaped (any
// literal `<`/`&`/etc. the model produced was parsed as markup instead of
// shown as text, the same stored-content-shaped risk isSafeLinkUrl in
// RichTextEditor.tsx already guards pasted links against) and with every line
// collapsed into one run-on paragraph (a `\n` is not significant HTML
// whitespace). Each non-blank line becomes its own escaped `<p>`; blank lines
// are dropped rather than kept as empty paragraphs.
function aiDraftBodyToHtml(body: string): string {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
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
  removePendingUpload(id: string): void;
  retryUpload(id: string): void;
  send(): Promise<boolean>;
  saveDraft(): Promise<boolean>;
  discardDraft(): void;
  draftWithAi(): Promise<void>;
} {
  const [state, dispatch] = useReducer(reducer, initial, initState);
  const queryClient = useQueryClient();

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

  // GH #278: a handle on the autosave that is currently running (or just ran),
  // so send() can await it before it decides which draft copy to trash. Without
  // it, send() would read currentDraftIdRef while an autosave is mid-flight and
  // about to advance it (persistDraft, below) — trashing the id the autosave is
  // superseding and leaving the fresh copy it creates orphaned in Drafts.
  const autosavePromiseRef = useRef<Promise<void> | null>(null);

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
    const snapshot = serializeDraftPayload(draft, attachments);
    const input: SaveDraftInput = { ...payload, originalDraftId: currentDraftIdRef.current };
    const result = await saveDraftRequest(input);
    currentDraftIdRef.current = result.id;
    lastSavedPayloadRef.current = snapshot;
    // GH #336: shared by autosave and the explicit "Save to drafts" action, so
    // both keep Drafts/the sidebar counters fresh without waiting on SSE.
    invalidateMailData(queryClient);
  }

  async function autosave(): Promise<void> {
    // GH #278: once the session is finalizing (a send in progress/done, or an
    // explicit discard), never create another draft copy — send() is about to
    // trash the one that already exists, and a save racing in behind it would
    // leave a fresh, un-trashed copy in Drafts.
    if (finalizedRef.current) return;
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
    // GH #278: keep a handle on the run this timer kicks off so send() can await
    // it before choosing which draft copy to trash.
    const timer = setTimeout(() => {
      autosavePromiseRef.current = autosave();
    }, AUTOSAVE_DEBOUNCE_MS);
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

  // GH #344(b): shared by the initial upload (addFiles below) and a retry
  // off an already-errored card (retryUpload below) — both issue the exact
  // same request against the exact same File, differing only in which
  // dispatch already put the upload's row in state.uploads.
  function runUpload(id: string, file: File): void {
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
      .catch((err) => {
        // GH #344(b): keep the server's code (e.g. payload_too_large for a
        // 413) so the error card can show the real message instead of the
        // generic fallback every failure used to render as.
        dispatch({ type: "uploadFailed", id, code: err instanceof MailApiError ? err.code : null });
      });
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
        upload: { id, name: file.name, size: file.size, progress: 0, error: false, errorCode: null, file },
      });
      runUpload(id, file);
    }

    return { skipped };
  }

  // GH #344(b): lets the user clear a failed upload's card without it
  // lingering forever (previously the only outcome of a failed upload) — and,
  // per emptiness.ts, a failed upload no longer counts as content anyway, so
  // this is purely a tidy-up, not something that can silently discard work.
  function removePendingUpload(id: string): void {
    dispatch({ type: "removePendingUpload", id });
  }

  // GH #344(b): retries the exact same File a failed upload already picked,
  // reusing runUpload so a retry is indistinguishable from a first attempt
  // once it resolves.
  function retryUpload(id: string): void {
    const upload = state.uploads.find((candidate) => candidate.id === id);
    if (!upload) return;
    dispatch({ type: "uploadRetryStart", id });
    runUpload(id, upload.file);
  }

  function removeAttachment(blobId: string): void {
    dispatch({ type: "removeAttachment", blobId });
  }

  async function send(): Promise<boolean> {
    const { draft, attachments, uploads } = state;
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      dispatch({ type: "sendFailed", error: "composer.errors.noRecipients" });
      return false;
    }
    // GH #344(a): send() used to read only `attachments`, so a file still
    // uploading (no blobId yet — see addFiles below) silently never made it
    // into the outgoing message. A FAILED upload does not block send: it
    // already surfaced as a visible error card (PendingUploadCard) the user
    // can remove or retry (GH #344b) — refusing to send over one they have
    // no way to clear would trap the composer instead of protecting it.
    if (uploads.some((upload) => !upload.error)) {
      dispatch({ type: "sendFailed", error: "composer.errors.uploadsPending" });
      return false;
    }

    const input = buildComposePayload(draft, attachments, { stripMarkers: true });

    dispatch({ type: "sendStart" });
    try {
      await sendEmail(input);
      // GH #336: Sent (and, when replying, the source thread/mailbox) just
      // changed server-side — refresh without waiting on SSE/window focus.
      invalidateMailData(queryClient);
      // The message left as mail, not a draft: block the unmount flush so the
      // onClose that follows a successful send can't recreate it as a draft.
      // GH #278: setting this before the trash below also stops any autosave
      // still to fire (the debounce timer, or a coalesced follow-up) from
      // creating a new draft copy behind the trash — autosave() now bails on
      // finalizedRef. Dropping the coalesced follow-up here keeps the in-flight
      // save (awaited next) from spawning one more copy on its way out.
      finalizedRef.current = true;
      pendingSaveRef.current = false;
      // GH #278: an autosave may be mid-flight right now — it will advance
      // currentDraftIdRef to the copy it is creating (persistDraft, above).
      // Wait for it to settle so the id we trash is the one actually sitting in
      // Drafts, not the stale id it superseded. Its own failure is irrelevant
      // to us here (the send already succeeded), hence the swallowed catch.
      if (autosavePromiseRef.current) {
        try {
          await autosavePromiseRef.current;
        } catch {
          // ignore — an autosave error never blocks a completed send
        }
      }
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

  // GH #304: the body text IS the user's intent. Expand what they typed into a
  // proper email; the subject is only a weak hint. If nothing was typed there is
  // no intent to expand, so prompt the user (Gmail-style) instead of drafting
  // from the subject alone — and skip the pointless network call.
  async function draftWithAi(): Promise<void> {
    const { editable, quoted } = splitQuotedTail(state.draft.bodyHtml);
    const intent = extractDraftIntent(editable);
    if (!intent) {
      dispatch({ type: "aiDraftNeedsIntent" });
      return;
    }
    dispatch({ type: "aiDraftStart" });
    try {
      // GH #299: on a reply, ground the draft in the original message (the
      // quoted tail of the body); a brand-new compose has none, so this is
      // undefined. The subject rides along as an optional hint.
      const context = extractReplyContext(state.draft);
      const subject = state.draft.subject.trim() || undefined;
      const body = await fetchAiDraft({ intent, subject, context });
      // Replace the composed body with the generated draft, keeping the quoted
      // reply tail intact so a reply's original message is not lost.
      dispatch({ type: "aiDraftSucceeded", bodyHtml: joinQuotedTail(aiDraftBodyToHtml(body), quoted) });
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

  return {
    state,
    setField,
    addFiles,
    removeAttachment,
    removePendingUpload,
    retryUpload,
    send,
    saveDraft,
    discardDraft,
    draftWithAi,
  };
}
