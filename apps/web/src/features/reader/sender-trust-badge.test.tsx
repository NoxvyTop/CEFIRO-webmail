import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { SenderTrustBadge } from "./SenderTrustBadge";

// GH #314: the positive-only trust tier above the authenticity badge. "none"
// renders nothing — it is the absence of an assertion, never a warning — and
// both positive tiers carry the REAL address/domain in their accessible name,
// so a reader (sighted or not) can check what exactly is being vouched for.
describe("SenderTrustBadge", () => {
  it("renders nothing for 'none'", () => {
    const { container } = render(<SenderTrustBadge trust="none" address="ana@partner.test" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the known-sender mark naming the exact address for 'known'", () => {
    render(<SenderTrustBadge trust="known" address="ana@partner.test" />);
    const badge = screen.getByRole("img", {
      name: i18n.t("mail.senderTrust.knownLabel", { address: "ana@partner.test" }),
    });
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute("aria-label")).toContain("ana@partner.test");
    expect(badge.getAttribute("title")).toContain("ana@partner.test");
  });

  it("renders the trusted-service mark naming the sender's domain for 'trusted-service'", () => {
    render(<SenderTrustBadge trust="trusted-service" address="notifications@noreply.github.com" />);
    const badge = screen.getByRole("img", {
      name: i18n.t("mail.senderTrust.trustedServiceLabel", { domain: "noreply.github.com" }),
    });
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute("aria-label")).toContain("noreply.github.com");
    // The domain, not the full address, is what Tier B vouches for.
    expect(badge.getAttribute("aria-label")).not.toContain("notifications@");
  });

  it("gives the two tiers distinct accessible names", () => {
    expect(i18n.t("mail.senderTrust.knownLabel", { address: "x@y.test" })).not.toBe(
      i18n.t("mail.senderTrust.trustedServiceLabel", { domain: "y.test" }),
    );
  });

  it("uses translated labels, not raw keys", () => {
    render(<SenderTrustBadge trust="known" address="ana@partner.test" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toContain("mail.senderTrust");
  });

  // The mark renders from the server-derived `trust` and the address the
  // server returned for `from[0]` — the same address ThreadView prints next to
  // it. There is no prop for a display name or body, so nothing a sender
  // controls can reach the icon or its label beyond the address itself.
  it("exposes no prop through which a display name could influence the mark", () => {
    // @ts-expect-error — verifying at the type level that SenderTrustBadge has
    // no `name`/`displayName` prop a caller could wire up by mistake.
    render(<SenderTrustBadge trust="known" address="ana@partner.test" name="✓ Trusted" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      i18n.t("mail.senderTrust.knownLabel", { address: "ana@partner.test" }),
    );
  });
});
