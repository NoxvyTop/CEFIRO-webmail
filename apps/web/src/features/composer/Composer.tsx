import { useRef, useState, type ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Identity, Signature } from "@webmail/shared";
import { fetchIdentities, fetchSignatures } from "./api";
import { useComposer } from "./useComposer";
import { RecipientField } from "./RecipientField";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposerDraft } from "./reply";
import { CloseIcon } from "../../app/ui/icons";
import { useToast } from "../../app/ui/toast";

interface ComposerProps {
  initial: ComposerDraft;
  onClose(): void;
}

function formatSizeKb(size: number): string {
  return `${(size / 1024).toFixed(1)} KB`;
}

export function Composer({ initial, onClose }: ComposerProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { state, setField, addFiles, removeAttachment, send, draftWithAi } = useComposer(initial);
  const [showCcBcc, setShowCcBcc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [appliedSignatureId, setAppliedSignatureId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const identitiesQuery = useQuery({ queryKey: ["mail", "identities"], queryFn: fetchIdentities });
  const signaturesQuery = useQuery({ queryKey: ["mail", "signatures"], queryFn: fetchSignatures });

  const identities: Identity[] = identitiesQuery.data ?? [];
  const signatures: Signature[] = signaturesQuery.data ?? [];

  function handleSignatureChange(signatureId: string) {
    setAppliedSignatureId(signatureId);
    if (!signatureId) return;
    const signature = signatures.find((candidate) => candidate.id === signatureId);
    if (!signature) return;
    setField("bodyHtml", `${state.draft.bodyHtml}<br>—<br>${signature.contentHtml}`);
  }

  async function handleSend() {
    const ok = await send();
    if (ok) {
      showToast(t("composer.sent"));
      onClose();
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) addFiles(files);
    event.target.value = "";
  }

  return (
    <div
      role="dialog"
      aria-label={t("composer.newMessage")}
      className="fixed inset-0 z-50 flex items-end justify-end bg-overlay p-6"
    >
      <div
        className="flex max-h-full w-full max-w-[640px] flex-col overflow-y-auto rounded-[14px] border border-line bg-panel shadow-pop"
        style={{ animation: "popIn 0.18s ease" }}
      >
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
              className="flex-1 appearance-none bg-transparent py-1 text-[13px] normal-case tracking-normal text-ink outline-none"
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
            className="border-0 border-b border-line bg-transparent px-0.5 py-3 text-[14px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-muted focus:border-accent"
          />

          <label className="flex items-center gap-2 border-0 border-b border-line py-1 text-[11px] uppercase tracking-wide text-muted focus-within:border-accent">
            {t("composer.signature")}
            <select
              aria-label={t("composer.signature")}
              value={appliedSignatureId}
              onChange={(event) => handleSignatureChange(event.target.value)}
              className="flex-1 appearance-none bg-transparent py-1 text-[13px] normal-case tracking-normal text-ink outline-none"
            >
              <option value="" />
              {signatures.map((signature) => (
                <option key={signature.id} value={signature.id}>
                  {signature.name}
                </option>
              ))}
            </select>
          </label>

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
              <ul className="flex flex-col gap-1">
                {state.attachments.map((attachment) => (
                  <li key={attachment.blobId} className="flex items-center justify-between gap-2 text-xs">
                    <span>
                      {attachment.name} ({formatSizeKb(attachment.size)})
                    </span>
                    <button
                      type="button"
                      aria-label={t("composer.removeAttachment", { name: attachment.name })}
                      onClick={() => removeAttachment(attachment.blobId)}
                      className="text-muted"
                    >
                      <CloseIcon size={14} />
                    </button>
                  </li>
                ))}
                {state.uploads.map((upload) => (
                  <li key={upload.id} className="flex items-center justify-between gap-2 text-xs">
                    <span>{upload.name}</span>
                    {upload.error ? (
                      <span role="alert" className="text-warn">
                        {t("composer.errors.generic")}
                      </span>
                    ) : (
                      <progress value={upload.progress} max={1} />
                    )}
                  </li>
                ))}
              </ul>
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
