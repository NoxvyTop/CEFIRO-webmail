import { useEffect } from "react";
import { useTranslation } from "react-i18next";

type ShortcutsOverlayProps = { open: boolean; onClose: () => void };

export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
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
        role="dialog"
        aria-label={t("shortcuts.overlayTitle")}
        onClick={(event) => event.stopPropagation()}
        className="w-[400px] rounded-[14px] border border-line bg-panel px-[26px] py-6 shadow-pop"
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
