import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Identity, Signature } from "@webmail/shared";
import { fetchIdentities, fetchSignatures } from "./api";
import { useComposer, type PendingUpload } from "./useComposer";
import { RecipientField } from "./RecipientField";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposerDraft } from "./reply";
import { applySignature } from "./signature";
import { CloseIcon } from "../../app/ui/icons";
import { useToast } from "../../app/ui/toast";
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

export function Composer({ initial, onClose, trashMailboxId }: ComposerProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { state, setField, addFiles, removeAttachment, send, draftWithAi } = useComposer(
    initial,
    trashMailboxId,
  );
  const [showCcBcc, setShowCcBcc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [appliedSignatureId, setAppliedSignatureId] = useState<string>("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards the default-signature auto-apply so it only runs once per composer
  // session (on open), not on every render once signatures finish loading.
  const appliedDefaultRef = useRef(false);

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
      role="dialog"
      aria-label={t("composer.newMessage")}
      className="fixed inset-0 z-50 flex items-end justify-end bg-overlay p-6"
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
            onClick={onClose}
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

          {!showCcBcc && (
            <button
              type="button"
              onClick={() => setShowCcBcc(true)}
              className="self-start text-xs text-accent-text underline"
            >
              {t("composer.addCcBcc")}
            </button>
          )}
          {showCcBcc && (
            <>
              <RecipientField
                label={t("composer.cc")}
                value={state.draft.cc}
                onChange={(value) => setField("cc", value)}
              />
              <RecipientField
                label={t("composer.bcc")}
                value={state.draft.bcc}
                onChange={(value) => setField("bcc", value)}
              />
            </>
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
          <button
            type="button"
            onClick={handleSend}
            disabled={state.sending}
            className="flex h-[38px] items-center gap-2 rounded-[11px] bg-accent px-[22px] text-[14px] font-bold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50"
          >
            {state.sending ? t("composer.sending") : t("composer.send")}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4Z" />
            </svg>
          </button>
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2.5 py-2 text-[13px] text-muted transition hover:bg-hover"
          >
            {t("composer.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
