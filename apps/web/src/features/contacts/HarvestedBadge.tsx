import { useTranslation } from "react-i18next";

// GH #163: the single place that renders "this address was added automatically".
//
// It exists as a component rather than inline markup because the defect it
// closes was precisely a drift between surfaces: `source` was stored from #124
// onward and read by neither the composer autocomplete nor contact management,
// so a stranger who mailed the user once appeared in autocomplete looking
// exactly like a colleague the user had vetted by hand. One component means the
// two surfaces cannot fall back out of step with each other.
//
// Accessibility: the cue is the translated *word*, not the border or the muted
// foreground. Because it is real text inside the row, it lands in that row's
// accessible name and a screen reader announces it along with the name and
// address — nothing here depends on colour alone (WCAG 1.4.1) or on an icon a
// reader would skip. The border and muted tone are redundant reinforcement.
//
// `withHint` adds the longer explanation as a native tooltip. Used in contact
// management, where the user is deliberately reviewing entries and hovering is
// natural; deliberately omitted in the composer's suggestion list, where the
// pointer passes over rows on its way to a selection and a tooltip would fire
// on options the user is only travelling through. The tooltip is never the
// only carrier of the meaning — the badge text already conveys it.
export function HarvestedBadge({ withHint = false }: { withHint?: boolean }) {
  const { t } = useTranslation();

  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border border-line px-1.5 py-px text-[11px] font-medium text-muted"
      title={withHint ? t("contacts.harvestedHint") : undefined}
    >
      {t("contacts.harvestedBadge")}
    </span>
  );
}
