import { useTranslation } from "react-i18next";

type MailboxGaugeProps = {
  linked: number;
  total: number;
};

/** Ring/donut gauge showing what share of mailboxes are linked, as a percentage.
 *  Rendered as a CSS conic-gradient so the filled arc (accent) and track (line)
 *  stay theme-aware via CSS custom properties — no hardcoded colors. Static by
 *  design: no transitions/animations to guard with prefers-reduced-motion. */
export function MailboxGauge({ linked, total }: MailboxGaugeProps) {
  const { t } = useTranslation();
  const percentage = total > 0 ? Math.round((linked / total) * 100) : 0;

  const accessibleLabel = t("admin.metrics.mailboxGaugeLabel", { linked, total, percentage });

  return (
    <div
      role="img"
      aria-label={accessibleLabel}
      className="relative flex h-[74px] w-[74px] shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(var(--accent) ${percentage}%, var(--line) ${percentage}%)` }}
    >
      <div className="flex h-[54px] w-[54px] items-center justify-center rounded-full bg-panel">
        <span aria-hidden="true" className="text-[13px] font-bold tabular-nums text-ink">
          {percentage}%
        </span>
      </div>
    </div>
  );
}
