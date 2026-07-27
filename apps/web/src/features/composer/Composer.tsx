import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Identity, Signature } from "@webmail/shared";
import { fetchIdentities, fetchSignatures } from "./api";
import { useComposer, type PendingUpload } from "./useComposer";
import { isComposerDraftEmpty } from "./emptiness";
import { RecipientField } from "./RecipientField";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposerDraft } from "./reply";
import { applySignature } from "./signature";
import { Button } from "../../app/ui/Button";
import { CloseIcon } from "../../app/ui/icons";
import { MODAL_SELECTOR } from "../../app/ui/shortcuts";
import { useToast } from "../../app/ui/toast";
import { useFocusTrap } from "../../app/ui/useFocusTrap";
import { AttachmentCard } from "../reader/AttachmentCard";

// A <select> exists to let the user choose between options. With at most one
// signature there is nothing to choose — it's apply-or-not, a toggle wearing
// a dropdown's clothes — so the selector only earns its place once there are
// at least this many signatures. One line to revisit if that threshold ever
// needs to change.
export const SIGNATURE_SELECTOR_MIN_COUNT = 2;

interface ComposerProps {
  initial: ComposerDraft;
  onClose(): void;
  // Passed through to useComposer so a successful send of an edited draft
  // (initial.originalDraftId set) can trash the stale original — see
  // reply.ts's buildEditDraft and useComposer.ts's send().
  trashMailboxId?: string | null;
}

// True only for a drag carrying actual OS files (dataTransfer.types includes
// "Files") — guards against hijacking normal text drag/selection inside form
// fields (e.g. dragging selected recipient/subject text around).
function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

// Pending uploads have no blobId yet, so they can't use AttachmentCard's
// server-blob preview — this is a compact placeholder shown in the same
// grid until the upload resolves (or errors) into a real attachment.
function PendingUploadCard({ upload }: { upload: PendingUpload }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="composer-pending-upload"
      className="flex w-[172px] shrink-0 flex-col justify-center gap-1 rounded-xl border border-line-strong bg-soft px-2.5 py-2 text-xs"
    >
      <span className="truncate">{upload.name}</span>
      {upload.error ? (
        <span role="alert" className="text-warn">
          {t("composer.errors.generic")}
        </span>
      ) : (
        <progress value={upload.progress} max={1} className="w-full" />
      )}
    </div>
  );
}

interface DiscardConfirmDialogProps {
  saving: boolean;
  saveError: string | null;
  onDiscard(): void;
  onSaveToDrafts(): void;
  onKeepEditing(): void;
}

// GH #125: shown when Escape is pressed on a composer that has content.
// Mirrors NewLabelModal.tsx/ShortcutsOverlay.tsx's existing dialog precedent
// in this codebase — a full-screen bg-overlay backdrop, backdrop-click
// dismissal, focus moved in on open and restored on close, and its own
// Escape-to-dismiss effect scoped to this dialog only (never the composer
// itself — see the outer Escape handler in Composer below, which defers to
// this dialog whenever it's mounted).
function DiscardConfirmDialog({
  saving, saveError, onDiscard, onSaveToDrafts, onKeepEditing,
}: DiscardConfirmDialogProps) {
  const { t } = useTranslation();
  // GH #158: focus-in/Tab-cycling/restore-on-close now come from the shared
  // useFocusTrap primitive — this dialog used to move focus in and restore
  // it on close by hand, but never cycled Tab, so focus could walk out of
  // this still-visible confirmation into the composer/page behind it.
  const dialogRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onKeepEditing();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onKeepEditing]);

  return (
    <div
      role="alertdialog"
      aria-label={t("composer.discardConfirm.title")}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-6"
      onClick={onKeepEditing}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex w-full max-w-[360px] flex-col gap-4 rounded-[14px] border border-line bg-panel p-5 shadow-pop outline-none"
        style={{ animation: "popIn 0.18s ease" }}
      >
        <div>
          <h2 className="text-[14px] font-[650]">{t("composer.discardConfirm.title")}</h2>
          <p className="mt-1 text-[13px] text-muted">{t("composer.discardConfirm.description")}</p>
        </div>
        {saveError && (
          <p role="alert" className="text-[12.5px] text-warn">
            {t(saveError)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onKeepEditing} disabled={saving}>
            {t("composer.discardConfirm.keepEditing")}
          </Button>
          <Button variant="secondary" onClick={onDiscard} disabled={saving}>
            {t("composer.discardConfirm.discard")}
          </Button>
          <Button variant="primary" onClick={onSaveToDrafts} disabled={saving}>
            {saving ? t("composer.discardConfirm.savingToDrafts") : t("composer.discardConfirm.saveToDrafts")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Composer({ initial, onClose, trashMailboxId }: ComposerProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { state, setField, addFiles, removeAttachment, send, saveDraft, draftWithAi } = useComposer(
    initial,
    trashMailboxId,
  );
  // Split into two independent reveal states (#123) — a draft arriving with
  // CC recipients (e.g. reply-all, see reply.ts's replyDraft) must show CC
  // without also showing an unrelated, still-empty BCC field, and vice versa.
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [appliedSignatureId, setAppliedSignatureId] = useState<string>("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards the default-signature auto-apply so it only runs once per composer
  // session (on open), not on every render once signatures finish loading.
  const appliedDefaultRef = useRef(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // GH #158: focus-in/Tab-cycling/restore-on-close for the composer's own
  // dialog — previously unmanaged entirely (no initial focus, no restore,
  // no Tab trap). Stays active for the composer's whole mounted lifetime
  // (never toggled off while the nested DiscardConfirmDialog is open):
  // useFocusTrap's own nested-dialog exclusion already keeps this trap from
  // fighting the nested one's Tab handling, so there is no need to suspend
  // it — doing so would instead race the nested dialog's own focus-in
  // effect for who gets to claim focus first.
  //
  // Also this dialog's own root element for the outer Escape handler below,
  // which uses it to tell its own dialog apart from a nested one (the
  // discard confirmation) layered on top of it — same identity GH #125
  // originally used a plain useRef for.
  const composerRootRef = useFocusTrap<HTMLDivElement>(true);

  // GH #159: the single decision point every exit route must go through —
  // "is the user abandoning this draft, or is the composer's work done?"
  // Closes immediately when the draft is empty, or opens the discard
  // confirmation otherwise (isComposerDraftEmpty, see composer/emptiness.ts).
  // Escape (below), the header close (X) button, and the bottom Cancel
  // button all call this instead of onClose() directly — GH #125 wired the
  // confirmation to the Escape *gesture* specifically, which left every
  // other way to close the composer (the X button, first and worst) calling
  // onClose() straight through with no check at all. Routing every "abandon"
  // exit through this one function means a future exit route inherits the
  // protection automatically instead of being born unguarded the same way.
  //
  // Exit routes that do NOT call this: handleDiscard (the confirmation's own
  // resolution, already past the check), handleSaveToDrafts and handleSend
  // on success (the composer's work is done, not abandoned — nothing to
  // confirm).
  function requestClose() {
    if (isComposerDraftEmpty(state.draft, state.attachments.length, state.uploads.length)) {
      onClose();
      return;
    }
    setDiscardConfirmOpen(true);
  }

  // Escape mirrors shortcuts.ts's isModalOpen reasoning — MODAL_SELECTOR
  // (GH #161) marks a keyboard-owning overlay — but isModalOpen itself can't
  // be reused unmodified here: it would always report "a dialog is open"
  // because this composer's own root already matches MODAL_SELECTOR. This
  // handler excludes that one element so a genuinely nested overlay (the
  // discard confirmation below, or any other dialog layered on top) still
  // gets to own Escape instead of this outer handler racing it.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      const overlays = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR);
      const hasNestedOverlay = Array.from(overlays).some((overlay) => overlay !== composerRootRef.current);
      if (hasNestedOverlay) return;

      requestClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestClose closes over the same state.draft/attachments/uploads/onClose already listed below
  }, [state.draft, state.attachments.length, state.uploads.length, onClose]);

  // GH #159: closing the browser tab (or the window) outright bypasses the
  // composer entirely — same silent-discard hole as the X button, just
  // through the browser's own exit door. A plain, standards-compliant
  // beforeunload guard, armed only while the draft actually has content
  // (mirrors requestClose above) so an untouched compose window never nags.
  // Setting returnValue (legacy) alongside preventDefault() covers browsers
  // that still require it to show their native confirmation prompt.
  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (isComposerDraftEmpty(state.draft, state.attachments.length, state.uploads.length)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [state.draft, state.attachments.length, state.uploads.length]);

  function handleKeepEditing() {
    setDiscardConfirmOpen(false);
  }

  function handleDiscard() {
    setDiscardConfirmOpen(false);
    onClose();
  }

  async function handleSaveToDrafts() {
    if (state.savingDraft) return;
    const ok = await saveDraft();
    if (ok) {
      setDiscardConfirmOpen(false);
      onClose();
    }
    // On failure, state.saveDraftError is already set by useComposer and
    // rendered inside DiscardConfirmDialog — stay open, draft intact.
  }

  const identitiesQuery = useQuery({ queryKey: ["mail", "identities"], queryFn: fetchIdentities });
  const signaturesQuery = useQuery({ queryKey: ["mail", "signatures"], queryFn: fetchSignatures });

  const identities: Identity[] = identitiesQuery.data ?? [];
  const signatures: Signature[] = signaturesQuery.data ?? [];

  // Auto-apply the default signature once, when signatures finish loading —
  // mirrors Gmail, which appends your default signature to every new email
  // (and reply/forward) without the user having to pick it manually.
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!signaturesQuery.data) return;
    appliedDefaultRef.current = true;
    const defaultSignature = signaturesQuery.data.find((candidate) => candidate.isDefault);
    if (!defaultSignature) return;
    setAppliedSignatureId(defaultSignature.id);
    setField("bodyHtml", applySignature(state.draft.bodyHtml, defaultSignature));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on load, guarded by appliedDefaultRef
  }, [signaturesQuery.data]);

  function handleSignatureChange(signatureId: string) {
    setAppliedSignatureId(signatureId);
    const signature = signatures.find((candidate) => candidate.id === signatureId) ?? null;
    setField("bodyHtml", applySignature(state.draft.bodyHtml, signature));
  }

  async function handleSend() {
    const ok = await send();
    if (ok) {
      showToast(t("composer.sent"));
      onClose();
    }
  }

  // Shared by both the hidden file input and drag&drop — addFiles already
  // dedups (name+size) and enforces the existing upload limits; this just
  // surfaces the dedup outcome as a toast, reusing the composer's existing
  // toast mechanism (also used for the "sent" confirmation above).
  function attachFiles(files: File[]) {
    const { skipped } = addFiles(files);
    if (skipped.length > 0) {
      showToast(t("composer.duplicateAttachment", { name: skipped[0] }));
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) attachFiles(files);
    event.target.value = "";
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    // Prevents the browser's default "open file" navigation anywhere over
    // the dialog, and signals to the browser that a drop is allowed here.
    event.preventDefault();
    setIsDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    // Ignore leaves into a child element (still inside the dialog) so the
    // overlay doesn't flicker while the pointer moves across nested nodes.
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    setIsDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setIsDraggingFiles(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) attachFiles(files);
  }

  return (
    <div
      ref={composerRootRef}
      role="dialog"
      aria-label={t("composer.newMessage")}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-end justify-end bg-overlay p-6 outline-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="relative flex max-h-full w-full max-w-[640px] flex-col overflow-y-auto rounded-[14px] border border-line bg-panel shadow-pop"
        style={{ animation: "popIn 0.18s ease" }}
      >
        {isDraggingFiles && (
          <div
            data-testid="composer-drop-overlay"
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[14px] border-2 border-dashed border-accent bg-accent/10 text-[15px] font-semibold text-accent-text"
          >
            {t("composer.dropHint")}
          </div>
        )}
        <div className="flex h-12 shrink-0 items-center gap-2.5 rounded-t-[14px] border-b border-line bg-soft px-[18px]">
          <h2 className="flex-1 text-[14px] font-[650]">{t("composer.newMessage")}</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t("composer.close")}
            className="rounded-md px-2 py-1 text-muted transition hover:bg-hover hover:text-ink"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 pb-4 pt-3">
          <label className="flex items-center gap-2 border-0 border-b border-line py-1 text-[11px] uppercase tracking-wide text-muted focus-within:border-accent">
            {t("composer.from")}
            <select
              aria-label={t("composer.from")}
              value={state.draft.identityId}
              onChange={(event) => setField("identityId", event.target.value)}
              className="flex-1 appearance-none bg-transparent py-1 text-[13px] normal-case tracking-normal text-ink field-focus-line"
            >
              {identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {`${identity.name} <${identity.email}>`}
                </option>
              ))}
            </select>
          </label>

          <RecipientField
            label={t("composer.to")}
            value={state.draft.to}
            onChange={(value) => setField("to", value)}
          />

          {(!showCc || !showBcc) && (
            <div className="flex items-center gap-3">
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="self-start text-xs text-accent-text underline"
                >
                  {t("composer.addCc")}
                </button>
              )}
              {!showBcc && (
                <button
                  type="button"
                  onClick={() => setShowBcc(true)}
                  className="self-start text-xs text-accent-text underline"
                >
                  {t("composer.addBcc")}
                </button>
              )}
            </div>
          )}
          {showCc && (
            <RecipientField
              label={t("composer.cc")}
              value={state.draft.cc}
              onChange={(value) => setField("cc", value)}
            />
          )}
          {showBcc && (
            <RecipientField
              label={t("composer.bcc")}
              value={state.draft.bcc}
              onChange={(value) => setField("bcc", value)}
            />
          )}

          <input
            aria-label={t("composer.subject")}
            placeholder={t("composer.subject")}
            value={state.draft.subject}
            onChange={(event) => setField("subject", event.target.value)}
            className="border-0 border-b border-line bg-transparent px-0.5 py-3 text-[14px] font-semibold text-ink field-focus-line focus:border-accent placeholder:font-normal placeholder:text-muted"
          />

          {signatures.length >= SIGNATURE_SELECTOR_MIN_COUNT && (
            <label className="flex items-center gap-2 border-0 border-b border-line py-1 text-[11px] uppercase tracking-wide text-muted focus-within:border-accent">
              {t("composer.signature")}
              <select
                aria-label={t("composer.signature")}
                value={appliedSignatureId}
                onChange={(event) => handleSignatureChange(event.target.value)}
                className="flex-1 appearance-none bg-transparent py-1 text-[13px] normal-case tracking-normal text-ink field-focus-line"
              >
                <option value="">{t("composer.noSignature")}</option>
                {signatures.map((signature) => (
                  <option key={signature.id} value={signature.id}>
                    {signature.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <RichTextEditor
            html={state.draft.bodyHtml}
            onChange={(html) => setField("bodyHtml", html)}
            ariaLabel={t("composer.body")}
          />

          <div className="flex flex-col gap-2">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label={t("composer.attach")}
                onChange={handleFileChange}
                className="sr-only"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md border border-line-strong px-3 py-1 text-sm hover:bg-hover"
              >
                {t("composer.attachFiles")}
              </button>
            </div>
            {(state.attachments.length > 0 || state.uploads.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {state.attachments.map((attachment) => (
                  <AttachmentCard
                    key={attachment.blobId}
                    attachment={{ ...attachment, cid: null }}
                    onRemove={() => removeAttachment(attachment.blobId)}
                  />
                ))}
                {state.uploads.map((upload) => (
                  <PendingUploadCard key={upload.id} upload={upload} />
                ))}
              </div>
            )}
          </div>

          {state.sendError && (
            <p role="alert" className="text-sm text-warn">
              {t(state.sendError)}
            </p>
          )}

          {state.aiDraftError && (
            <p role="alert" className="text-sm text-warn">
              {t(state.aiDraftError)}
            </p>
          )}
          {state.aiDraftNotice && (
            <p className="text-xs text-muted">{t("composer.aiDraftNotice")}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 px-5 py-4">
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={state.sending}
            className="flex h-[38px] items-center gap-2 rounded-[11px] px-[22px] text-[14px] font-bold"
          >
            {state.sending ? t("composer.sending") : t("composer.send")}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4Z" />
            </svg>
          </Button>
          {!state.aiUnavailable && (
            <button
              type="button"
              onClick={() => void draftWithAi()}
              disabled={state.aiDrafting}
              className="flex h-[38px] items-center gap-2 rounded-[11px] border border-accent px-4 text-[13.5px] font-semibold text-accent-text transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50"
            >
              {state.aiDrafting ? t("composer.draftingWithAi") : t("composer.draftWithAi")}
            </button>
          )}
          <span className="flex-1" />
          <Button
            variant="secondary"
            onClick={requestClose}
            className="rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {t("composer.cancel")}
          </Button>
        </div>
      </div>
      {discardConfirmOpen && (
        <DiscardConfirmDialog
          saving={state.savingDraft}
          saveError={state.saveDraftError}
          onDiscard={handleDiscard}
          onSaveToDrafts={() => void handleSaveToDrafts()}
          onKeepEditing={handleKeepEditing}
        />
      )}
    </div>
  );
}
