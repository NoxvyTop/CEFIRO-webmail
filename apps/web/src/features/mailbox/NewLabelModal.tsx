import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CustomLabel } from "@webmail/shared";
import { useTranslation } from "react-i18next";
import { CloseIcon } from "../../app/ui/icons";
import { CUSTOM_LABEL_PALETTE, isLabelNameTaken, slugifyLabelName } from "../../app/ui/labels";
import { useFocusTrap } from "../../app/ui/useFocusTrap";

interface NewLabelModalProps {
  customLabels: CustomLabel[];
  onCreateLabel: (label: CustomLabel) => void;
  onClose: () => void;
}

// GH #109: replaces the old inline "Nueva etiqueta" form with a CENTERED
// modal — mirrors Composer's dialog shell (role="dialog" + aria-label, a
// full-screen bg-overlay backdrop, a rounded/bordered popIn panel), but uses
// `items-center justify-center` instead of Composer's bottom-right anchor,
// and adds backdrop-click/Escape dismissal (Composer doesn't need those —
// ShortcutsOverlay/AttachmentViewer are this codebase's precedent for that
// behavior on a centered dialog).
export function NewLabelModal({ customLabels, onCreateLabel, onClose }: NewLabelModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState(CUSTOM_LABEL_PALETTE[0]!);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // GH #158: focuses the name input (not the dialog chrome) on open, cycles
  // Tab within the dialog — this modal previously never cycled Tab at all —
  // and restores focus to whatever triggered it (the "Nueva etiqueta"
  // button) on close/unmount.
  const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: nameInputRef });

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    const slug = slugifyLabelName(trimmed);
    if (slug.length === 0) {
      setError(t("mail.labelNameRequired"));
      return;
    }
    if (isLabelNameTaken(trimmed, customLabels)) {
      setError(t("mail.labelNameDuplicate"));
      return;
    }
    onCreateLabel({ slug, name: trimmed, color });
    onClose();
  }

  return (
    <div
      role="dialog"
      // GH #253: the last of the four dialogs that trapped focus (#158) without
      // telling assistive tech the rest of the page is inert.
      aria-modal="true"
      aria-label={t("mail.newLabel")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex w-full max-w-[360px] flex-col rounded-[14px] border border-line bg-panel shadow-pop outline-none"
        style={{ animation: "popIn 0.18s ease" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 rounded-t-[14px] border-b border-line bg-soft px-[18px]">
          <h2 className="flex-1 text-[14px] font-[650]">{t("mail.newLabel")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("composer.close")}
            className="rounded-md px-2 py-1 text-muted transition hover:bg-hover hover:text-ink"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 px-5 py-4">
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder={t("mail.labelNamePlaceholder")}
            aria-label={t("mail.labelNamePlaceholder")}
            className="h-9 rounded-[8px] border border-line bg-transparent px-2.5 text-[13px] text-ink field-focus"
          />
          <div className="flex flex-wrap gap-1.5">
            {CUSTOM_LABEL_PALETTE.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={t("mail.chooseLabelColor", { hex })}
                aria-pressed={color === hex}
                onClick={() => setColor(hex)}
                className={`h-5 w-5 shrink-0 rounded-full border-2 ${
                  color === hex ? "border-accent" : "border-transparent"
                }`}
                style={{ background: hex }}
              />
            ))}
          </div>
          {error && (
            <p role="alert" className="text-[11.5px] text-warn">
              {error}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="flex h-9 flex-1 items-center justify-center rounded-[8px] bg-accent text-[13px] font-semibold text-accent-ink"
            >
              {t("mail.createLabel")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 items-center justify-center rounded-[8px] px-3 text-[13px] text-muted hover:text-ink"
            >
              {t("mail.cancelNewLabel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
