import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Signature, SignatureInput } from "@webmail/shared";
import { createSignature, deleteSignature, fetchSignatures, updateSignature } from "../composer/api";
import { RichTextEditor } from "../composer/RichTextEditor";

const SIGNATURES_QUERY_KEY = ["mail", "signatures"] as const;

const EMPTY_FORM = { name: "", contentHtml: "", isDefault: false };

export function SignatureSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signaturesQuery = useQuery({ queryKey: SIGNATURES_QUERY_KEY, queryFn: fetchSignatures });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  function invalidateSignatures() {
    return queryClient.invalidateQueries({ queryKey: SIGNATURES_QUERY_KEY });
  }

  function resetForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  const createMutation = useMutation({
    mutationFn: (input: SignatureInput) => createSignature(input),
    onSuccess: async () => {
      await invalidateSignatures();
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SignatureInput }) => updateSignature(id, input),
    onSuccess: async () => {
      await invalidateSignatures();
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSignature(id),
    onSuccess: () => invalidateSignatures(),
  });

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function startEdit(signature: Signature) {
    setEditingId(signature.id);
    setForm({ name: signature.name, contentHtml: signature.contentHtml, isDefault: signature.isDefault });
    setFormOpen(true);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const input: SignatureInput = {
      name: form.name,
      contentHtml: form.contentHtml,
      isDefault: form.isDefault,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, input });
    } else {
      createMutation.mutate(input);
    }
  }

  const signatures = signaturesQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {signatures.map((signature) => (
          <li
            key={signature.id}
            className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
          >
            <div className="flex items-center gap-2">
              <span>{signature.name}</span>
              {signature.isDefault && (
                <span className="rounded-full bg-sel px-2 py-0.5 text-xs text-accent">
                  {t("settings.default")}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => startEdit(signature)}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
              >
                {t("settings.edit")}
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(signature.id)}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
              >
                {t("settings.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {!formOpen && (
        <button
          type="button"
          onClick={startCreate}
          className="self-start rounded-md border border-line px-3 py-1 text-sm hover:bg-hover"
        >
          {t("settings.newSignature")}
        </button>
      )}

      {formOpen && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="signature-name" className="flex flex-col gap-1 text-sm">
            {t("settings.name")}
            <input
              id="signature-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
            />
          </label>

          <RichTextEditor
            html={form.contentHtml}
            onChange={(contentHtml) => setForm({ ...form, contentHtml })}
            ariaLabel={t("composer.body")}
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
            />
            {t("settings.default")}
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover"
            >
              {t("composer.cancel")}
            </button>
            <button
              type="submit"
              className="rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink transition hover:brightness-[1.07] active:scale-[0.98]"
            >
              {t("settings.save")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
