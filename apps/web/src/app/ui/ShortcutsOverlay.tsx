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

  const rows: Array<[string, string]> = [
    ["j / k", t("shortcuts.move")],
    ["e", t("shortcuts.archive")],
    ["s", t("shortcuts.star")],
    ["r", t("shortcuts.reply")],
    ["c", t("shortcuts.compose")],
    ["/", t("shortcuts.search")],
    ["Esc", t("shortcuts.close")],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(3,5,9,0.55)]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("shortcuts.title")}
        onClick={(event) => event.stopPropagation()}
        className="w-[400px] rounded-[14px] border border-line bg-panel p-5 shadow-pop"
      >
        <h2 className="mb-4 text-sm font-semibold">{t("shortcuts.title")}</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          {rows.map(([keys, label]) => (
            <div key={keys} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="justify-self-end">
                <kbd className="rounded border border-line bg-soft px-1.5 text-[11px]">{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
