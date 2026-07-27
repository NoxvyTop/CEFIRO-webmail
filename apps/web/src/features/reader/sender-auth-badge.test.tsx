import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { SenderAuthBadge } from "./SenderAuthBadge";

// GH #136: the reader's sender-authenticity indicator. "unknown" renders
// nothing — under-claiming is always the safe default (see
// apps/server/src/modules/mail/sender-auth.ts): a genuine message shown
// without a mark costs nothing, a forged one shown with a wrong mark could
// cost a reader their credentials.
describe("SenderAuthBadge", () => {
  it("renders nothing for the 'unknown' verdict", () => {
    const { container } = render(<SenderAuthBadge verdict="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a positive mark with an accessible name stating the actual meaning, for 'pass'", () => {
    render(<SenderAuthBadge verdict="pass" />);
    const badge = screen.getByRole("img", { name: i18n.t("mail.senderAuth.passLabel") });
    expect(badge).toBeInTheDocument();
    // The accessible name must say what it actually means, not just describe
    // an icon/color.
    expect(i18n.t("mail.senderAuth.passLabel").toLowerCase()).not.toBe("check");
  });

  it("renders a visible warning with an accessible name stating the actual meaning, for 'fail'", () => {
    render(<SenderAuthBadge verdict="fail" />);
    const badge = screen.getByRole("img", { name: i18n.t("mail.senderAuth.failLabel") });
    expect(badge).toBeInTheDocument();
  });

  it("renders the pass and fail badges with visually/programmatically distinct accessible names", () => {
    const passLabel = i18n.t("mail.senderAuth.passLabel");
    const failLabel = i18n.t("mail.senderAuth.failLabel");
    expect(passLabel).not.toBe(failLabel);
  });

  // The mark must render exclusively from the server-derived `verdict` prop,
  // never from anything a sender controls (message body, display name). This
  // component takes no sender/body input at all — there is no prop through
  // which a sender-controlled string could reach the badge — so a display
  // name containing a checkmark character (e.g. "✓ Trusted Sender") can never
  // be read as this component's mark. Asserted here by checking the
  // component's own prop surface stays limited to `verdict`.
  it("exposes no prop through which sender-controlled content (e.g. display name) could influence the mark", () => {
    // @ts-expect-error — verifying at the type level that SenderAuthBadge has
    // no `name`/`sender`/`displayName` prop a caller could wire up by mistake.
    render(<SenderAuthBadge verdict="pass" senderName="✓ Trusted Sender" />);
    // Even if such a prop were accidentally passed at runtime (e.g. from
    // untyped JS), the accessible name is still the fixed, translated label —
    // never anything derived from that extra prop.
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(i18n.t("mail.senderAuth.passLabel"));
  });
});
