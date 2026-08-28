import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "./useFocusTrap";

type ShortcutsOverlayProps = { open: boolean; onClose: () => void };

export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useTranslation();
  // GH #158: focus-in/Tab-cycling/restore-on-close now come from the shared
  // useFocusTrap primitive — this component used to hand-roll all three.
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      // #348: App.tsx's own global "?" handler (the one that opened this
      // overlay) is gated by isPlainShortcut(), which returns false while
      // this dialog is open (see shortcuts.ts's isModalOpen) — so "?" must
      // close from in here instead, the same way every other single-key
      // shortcut this overlay documents (j/k/e/s/r/c) is scoped to whatever
      // owns the keyboard at the time.
      if (event.key === "Escape" || event.key === "?") onClose();
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
    // GH #226: the backdrop gains the same padding ThreadView's
    // DeletePermanentlyConfirmDialog already uses, so the card below can cap
    // itself at the viewport width without touching its edges on a phone.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.overlayTitle")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        // GH #226: was a hard w-[400px] with no cap, so on a 375px phone the
        // card was wider than the screen and its right-hand key column sat off
        // it. Same shape as DeletePermanentlyConfirmDialog's card: full width
        // of the padded backdrop, capped at the design width.
        className="w-full max-w-[400px] rounded-[14px] border border-line bg-panel px-[26px] py-6 shadow-pop outline-none"
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
