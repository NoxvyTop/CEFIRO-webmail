import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

type ShortcutsOverlayProps = { open: boolean; onClose: () => void };

// Elements a Tab-based focus trap should cycle through. Mirrors the common
// "visible and operable" focusable selector list (no [inert]/hidden checks
// needed here since the dialog content is fully static).
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Move focus into the dialog on open, and restore it to whatever triggered
  // it once the dialog closes (open flips back to false, or the component
  // unmounts while still open).
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        // Nothing to cycle through — keep focus pinned to the dialog itself.
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows: Array<[string[], string]> = [
    [["j", "k"], t("shortcuts.move")],
    [["e"], t("shortcuts.archive")],
    [["s"], t("shortcuts.star")],
    [["r"], t("shortcuts.reply")],
    [["c"], t("shortcuts.compose")],
    [["/"], t("shortcuts.search")],
    [["Esc"], t("shortcuts.close")],
  ];

  const kbdClass = "rounded-[5px] border border-line bg-soft px-2 py-[2px] text-[11.5px]";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.overlayTitle")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="w-[400px] rounded-[14px] border border-line bg-panel px-[26px] py-6 shadow-pop outline-none"
        style={{ animation: "popIn 0.18s ease" }}
      >
        <h2 className="mb-4 text-[16px] font-[650]">{t("shortcuts.overlayTitle")}</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-[11px] text-[13.5px]">
          {rows.map(([keys, label]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="flex justify-self-end gap-[5px]">
                {keys.map((key) => (
                  <kbd key={key} className={kbdClass}>
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
