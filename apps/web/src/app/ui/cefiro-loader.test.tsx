import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../i18n";
import i18n from "../i18n";
import { CefiroLoader } from "./CefiroLoader";

// GH #94: branded (Céfiro logo) loading indicator meant to sit ON TOP of
// pending states that already exist elsewhere (React Query isLoading, the
// pdf.js loading fallback) — this file only covers the presentational
// component itself: the logo + optional "Cargando…" label, sized for either
// a large centered reader-pane use or a compact attachment-card use, with an
// accessible status role so screen readers announce it either way.
describe("CefiroLoader", () => {
  it("renders the logo mark", () => {
    render(<CefiroLoader />);

    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("shows the visible 'Cargando…' label when label is true", () => {
    render(<CefiroLoader label />);

    expect(screen.getByText(i18n.t("mail.loading"))).toBeInTheDocument();
  });

  it("renders no visible label by default (compact use, e.g. inside a small attachment card)", () => {
    render(<CefiroLoader />);

    expect(screen.queryByText(i18n.t("mail.loading"))).not.toBeInTheDocument();
  });

  it("exposes an accessible status role with a loading name even without a visible label", () => {
    render(<CefiroLoader />);

    const status = screen.getByRole("status");
    expect(status).toHaveAccessibleName(i18n.t("mail.loading"));
  });

  it("keeps the accessible status role and name when labeled", () => {
    render(<CefiroLoader label />);

    const status = screen.getByRole("status");
    expect(status).toHaveAccessibleName(i18n.t("mail.loading"));
  });

  it("renders the requested size on the underlying logo svg", () => {
    render(<CefiroLoader size={64} />);

    expect(document.querySelector("svg")).toHaveAttribute("width", "64");
  });

  it("defaults to a reasonable size when none is given", () => {
    render(<CefiroLoader />);

    const svg = document.querySelector("svg");
    expect(svg?.getAttribute("width")).toBeTruthy();
  });

  it("spins the logo mark at a faster (loading) pace than the ambient 28s banner spin, via CSS animation only", () => {
    render(<CefiroLoader />);

    const spinningGroup = document.querySelector("g");
    const style = spinningGroup?.getAttribute("style") ?? "";
    expect(style).toContain("animation");
    expect(style).not.toContain("28s");
  });
});
