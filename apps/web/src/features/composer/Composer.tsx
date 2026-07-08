import { useState, type ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Identity, Signature } from "@webmail/shared";
import { fetchIdentities, fetchSignatures } from "./api";
import { useComposer } from "./useComposer";
import { RecipientField } from "./RecipientField";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposerDraft } from "./reply";
import { CloseIcon } from "../../app/ui/icons";

interface ComposerProps {
  initial: ComposerDraft;
  onClose(): void;
}

function formatSizeKb(size: number): string {
  return `${(size / 1024).toFixed(1)} KB`;
}

export function Composer({ initial, onClose }: ComposerProps) {
  const { t } = useTranslation();
  const { state, setField, addFiles, removeAttachment, send } = useComposer(initial);
  const [showCcBcc, setShowCcBcc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [appliedSignatureId, setAppliedSignatureId] = useState<string>("");

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
    if (ok) onClose();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) addFiles(files);
    event.target.value = "";
  }

  return (
    <div
      role="dialog"
      aria-label={t("composer.title")}
      className="fixed inset-0 z-50 flex items-end justify-end bg-[rgba(3,5,9,0.55)] p-6"
    >
      <div className="flex max-h-full w-full max-w-[640px] flex-col gap-3 overflow-y-auto rounded-[14px] border border-line bg-panel p-4 shadow-[0_24px_70px_rgba(0,0,0,0.5)]">
        <h2 className="-mx-4 -mt-4 flex h-12 items-center rounded-t-[14px] bg-soft px-4 text-sm font-semibold">{t("composer.title")}</h2>

        <label className="flex flex-col gap-1 text-sm">
          {t("composer.from")}
          <select
            aria-label={t("composer.from")}
            value={state.draft.identityId}
            onChange={(event) => setField("identityId", event.target.value)}
            className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
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
            className="self-start text-xs text-accent underline"
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

        <label className="flex flex-col gap-1 text-sm">
          {t("composer.subject")}
          <input
            aria-label={t("composer.subject")}
            value={state.draft.subject}
            onChange={(event) => setField("subject", event.target.value)}
            className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("composer.signature")}
          <select
            aria-label={t("composer.signature")}
            value={appliedSignatureId}
            onChange={(event) => handleSignatureChange(event.target.value)}
            className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
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
          <label className="text-sm">
            {t("composer.attach")}
            <input
              type="file"
              multiple
              aria-label={t("composer.attach")}
              onChange={handleFileChange}
              className="mt-1 block text-sm"
            />
          </label>
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

        <div className="mt-2 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover">
            {t("composer.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={state.sending}
            className="flex items-center gap-2 rounded-[11px] bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-[0_2px_14px_rgba(111,227,193,0.25)] transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4Z" />
            </svg>
            {state.sending ? t("composer.sending") : t("composer.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
