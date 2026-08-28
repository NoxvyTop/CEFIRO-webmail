import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Signature, SignatureInput } from "@webmail/shared";
import { createSignature, deleteSignature, fetchSignatures, updateSignature } from "../composer/api";
import { RichTextEditor } from "../composer/RichTextEditor";
import { SettingsLoadError, SettingsLoading, SettingsMutationError } from "./PanelStates";

const SIGNATURES_QUERY_KEY = ["mail", "signatures"] as const;

const EMPTY_FORM = { name: "", contentHtml: "", isDefault: false };

// Below this many signatures there's nothing to pick between, so the
// edit-first view (the single relevant signature's editor, open and ready)
// is shown instead of the list — most people have exactly one signature and
// should never have to click through a list of one to reach it.
const LIST_VIEW_MIN_COUNT = 2;

export function SignatureSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signaturesQuery = useQuery({ queryKey: SIGNATURES_QUERY_KEY, queryFn: fetchSignatures });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  // True only while the user has explicitly started drafting an *additional*
  // signature from the edit-first view — guards the sync effect below from
  // immediately overwriting that blank draft with the existing signature's
  // data (which it would otherwise do, since the draft isn't saved yet and
  // still counts as "one signature" from the query's point of view).
  const [creatingAdditional, setCreatingAdditional] = useState(false);
  // #348: deleting a signature is irreversible — mirrors Sidebar.tsx's
  // inline two-step confirm for deleting a label (GH #103) rather than
  // deleting on the first click. Shared by both the list-view row delete
  // button and the edit-first view's delete button, since only one of the
  // two is ever rendered at a time.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  // GH #148: the last failed create/edit/delete, or null. Held here rather than
  // read off the three mutations' own `error` fields because those keep their
  // last failure until the SAME mutation runs again — a create that failed
  // would go on being reported while an unrelated delete succeeded. One slot,
  // cleared the moment any write is attempted or lands, is what the sibling
  // sections (ProfileSettings, VacationSettings, ContactsSettings) already do.
  const [mutationError, setMutationError] = useState<unknown>(null);

  const signatures = signaturesQuery.data ?? [];
  const isListView = signatures.length >= LIST_VIEW_MIN_COUNT;
  const defaultSignature = signatures.find((candidate) => candidate.isDefault) ?? signatures[0] ?? null;

  function invalidateSignatures() {
    return queryClient.invalidateQueries({ queryKey: SIGNATURES_QUERY_KEY });
  }

  function resetForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setCreatingAdditional(false);
    setConfirmingDeleteId(null);
  }

  // A new attempt clears the previous verdict, so the alert on screen always
  // belongs to the write the user is watching.
  function beginMutation() {
    setMutationError(null);
  }

  const createMutation = useMutation({
    mutationFn: (input: SignatureInput) => createSignature(input),
    onMutate: beginMutation,
    onSuccess: async () => {
      await invalidateSignatures();
      resetForm();
    },
    onError: (error) => setMutationError(error),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SignatureInput }) => updateSignature(id, input),
    onMutate: beginMutation,
    onSuccess: async () => {
      await invalidateSignatures();
      resetForm();
    },
    onError: (error) => setMutationError(error),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSignature(id),
    onMutate: beginMutation,
    onSuccess: async () => {
      setConfirmingDeleteId(null);
      await invalidateSignatures();
    },
    onError: (error) => setMutationError(error),
  });

  // Keeps the edit-first view's form synced to the current solo/default
  // signature whenever its identity changes: on initial load, and on the
  // list-to-edit-first transition after a delete brings the count down to
  // one (or to zero, where it falls back to a blank create form). Skipped
  // entirely in list view (formOpen/editingId are driven directly by
  // startCreate/startEdit/resetForm there, as before) and while the user is
  // actively drafting an additional signature.
  useEffect(() => {
    if (isListView || creatingAdditional) return;
    if (defaultSignature) {
      if (editingId !== defaultSignature.id) {
        setEditingId(defaultSignature.id);
        setForm({
          name: defaultSignature.name,
          contentHtml: defaultSignature.contentHtml,
          isDefault: defaultSignature.isDefault,
        });
      }
      return;
    }
    if (editingId !== null) {
      setEditingId(null);
      setForm(EMPTY_FORM);
    }
  }, [isListView, creatingAdditional, defaultSignature, editingId]);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setConfirmingDeleteId(null);
  }

  // Reached from the edit-first view via the "New signature" button — starts
  // a blank draft for a second signature without losing the existing one
  // (still shown once this draft is cancelled or, on save, once the list
  // view takes over at two signatures).
  function startCreateAdditional() {
    setCreatingAdditional(true);
    startCreate();
  }

  function startEdit(signature: Signature) {
    setEditingId(signature.id);
    setForm({ name: signature.name, contentHtml: signature.contentHtml, isDefault: signature.isDefault });
    setFormOpen(true);
    setConfirmingDeleteId(null);
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

  // GH #250: loading, failed and empty are three different things. Empty is
  // the open blank editor below (#132's edit-first view), so only the first
  // two are handled here — the previous `if (!data) return null` collapsed a
  // failed load into a blank panel with nothing to retry.
  if (signaturesQuery.isError) {
    return (
      <SettingsLoadError
        error={signaturesQuery.error}
        onRetry={() => void signaturesQuery.refetch()}
      />
    );
  }

  if (!signaturesQuery.data) {
    return <SettingsLoading />;
  }

  const showForm = !isListView || formOpen;

  return (
    <div className="flex flex-col gap-4">
      {/* GH #148: a create/edit/delete that failed used to change nothing on
          screen at all — the form stayed open with the same content, which is
          also what a successful edit of the solo signature looks like. */}
      {mutationError != null && <SettingsMutationError error={mutationError} />}

      {isListView && (
        <ul className="flex flex-col gap-2">
          {signatures.map((signature) => (
            <li
              key={signature.id}
              className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
            >
              {confirmingDeleteId === signature.id ? (
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <span className="flex-1 text-warn">
                    {t("settings.confirmDeleteSignatureQuestion", { name: signature.name })}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(signature.id)}
                    className="rounded-[9px] px-2 py-1 text-xs font-semibold text-warn transition hover:bg-hover"
                  >
                    {t("settings.confirmDeleteAction")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteId(null)}
                    className="rounded-[9px] px-2 py-1 text-xs text-muted transition hover:bg-hover"
                  >
                    {t("settings.cancelDelete")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span>{signature.name}</span>
                    {signature.isDefault && (
                      <span className="rounded-full bg-sel px-2 py-0.5 text-xs text-accent-text">
                        {t("settings.default")}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(signature)}
                      className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
                    >
                      {t("settings.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(signature.id)}
                      className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
                    >
                      {t("settings.delete")}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {isListView && !formOpen && (
        <button
          type="button"
          onClick={startCreate}
          className="self-start rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
        >
          {t("settings.newSignature")}
        </button>
      )}

      {!isListView && editingId && (
        <button
          type="button"
          onClick={startCreateAdditional}
          className="self-start rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
        >
          {t("settings.newSignature")}
        </button>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="signature-name" className="flex flex-col gap-1 text-sm">
            {t("settings.name")}
            <input
              id="signature-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
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
              name="signature-is-default"
              checked={form.isDefault}
              onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
            />
            {t("settings.default")}
          </label>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {!isListView && editingId && confirmingDeleteId === editingId ? (
              <div className="mr-auto flex flex-wrap items-center gap-2">
                <span className="text-sm text-warn">
                  {t("settings.confirmDeleteSignatureQuestion", { name: form.name })}
                </span>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(editingId)}
                  className="rounded-[9px] border border-line-strong px-3 py-1 text-sm font-semibold text-warn transition hover:border-accent hover:bg-hover"
                >
                  {t("settings.confirmDeleteAction")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDeleteId(null)}
                  className="rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
                >
                  {t("settings.cancelDelete")}
                </button>
              </div>
            ) : (
              !isListView &&
              editingId && (
                <button
                  type="button"
                  onClick={() => setConfirmingDeleteId(editingId)}
                  className="mr-auto rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
                >
                  {t("settings.delete")}
                </button>
              )
            )}
            <button
              type="button"
              onClick={resetForm}
              className="rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
            >
              {t("composer.cancel")}
            </button>
            <button
              type="submit"
              className="rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
            >
              {t("settings.save")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
