import { useState, type ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Identity, Signature } from "@webmail/shared";
import { fetchIdentities, fetchSignatures } from "./api";
import { useComposer } from "./useComposer";
import { RecipientField } from "./RecipientField";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposerDraft } from "./reply";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-md bg-white p-4">
        <h2 className="text-lg font-semibold">{t("composer.title")}</h2>

        <label className="flex flex-col gap-1 text-sm">
          {t("composer.from")}
          <select
            aria-label={t("composer.from")}
            value={state.draft.identityId}
            onChange={(event) => setField("identityId", event.target.value)}
            className="rounded-md border p-1"
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
            className="self-start text-xs text-blue-700 underline"
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
            className="rounded-md border p-1"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t("composer.signature")}
          <select
            aria-label={t("composer.signature")}
            value={appliedSignatureId}
            onChange={(event) => handleSignatureChange(event.target.value)}
            className="rounded-md border p-1"
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
                    className="text-gray-500"
                  >
                    ×
                  </button>
                </li>
              ))}
              {state.uploads.map((upload) => (
                <li key={upload.id} className="flex items-center justify-between gap-2 text-xs">
                  <span>{upload.name}</span>
                  {upload.error ? (
                    <span role="alert" className="text-amber-700">
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
          <p role="alert" className="text-sm text-amber-700">
            {t(state.sendError)}
          </p>
        )}

        <div className="mt-2 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm">
            {t("composer.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={state.sending}
            className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            {state.sending ? t("composer.sending") : t("composer.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
