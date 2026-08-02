import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./i18n";
import i18n from "./i18n";
import { routes } from "./routes";
import { expectNoShellAxeViolations } from "../test/axe";

const user = {
  userId: "u1",
  email: "emp@noxvytop.com",
  displayName: "Emp",
  role: "employee",
  locale: "es",
};

function renderApp() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) {
        return new Response(JSON.stringify(user));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("App search input focus treatment", () => {
  it("carries the visible boxed focus indicator on the bordered wrapper, not the transparent inner input", async () => {
    renderApp();

    const searchInput = await screen.findByRole("searchbox", {
      name: i18n.t("mail.searchPlaceholder"),
    });
    // The search field is a boxed archetype whose border+radius live on the
    // wrapper. The visible affordance (accent border + ring) must sit on that
    // bordered wrapper via focus-within, or the accent border no-ops against
    // Tailwind's border:0 preflight and focus becomes near-invisible (the
    // regression both review judges caught).
    const wrapper = searchInput.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass("field-focus-within");
    // Old ad-hoc wrapper outline is gone (assert on the wrapper, where it lived).
    expect(wrapper?.className).not.toMatch(/outline-accent/);
    expect(wrapper?.className).not.toMatch(/outline-2/);

    // The transparent inner input only suppresses its own hard outline; it must
    // not carry the boxed ring (that belongs to the wrapper).
    expect(searchInput).toHaveClass("field-focus-line");
    expect(searchInput).not.toHaveClass("field-focus");
  });
});

describe("App header avatar fallback", () => {
  it("shows initials (no img) in the header when the profile has no photo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/auth/me")) return new Response(JSON.stringify(user));
        if (path.includes("/api/profile")) {
          return new Response(
            JSON.stringify({ displayName: user.displayName, email: user.email, avatarDataUrl: null }),
          );
        }
        return new Response(JSON.stringify({ status: "ok", checks: {} }));
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const avatarButton = await screen.findByRole("button", {
      name: i18n.t("auth.signedInAs", { email: user.email }),
    });
    // "Emp" -> single-word initials fallback; no <img> means no avatar photo
    // was rendered, i.e. the UserMenu/Avatar wiring fell back correctly.
    expect(within(avatarButton).getByText("E")).toBeInTheDocument();
    expect(avatarButton.querySelector("img")).toBeNull();
  });
});

describe("App accessibility shell", () => {
  it("exposes a skip-to-content link that targets the main landmark", async () => {
    renderApp();

    // The skip link is the first focusable element, hidden until focused, and
    // its href must resolve to the <main> the shell wraps the Outlet in.
    const skipLink = await screen.findByRole("link", { name: i18n.t("app.skipToContent") });
    expect(skipLink).toHaveAttribute("href", "#main-content");

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
  });

  it("passes an axe run over the mounted shell with the landmark/region rules enabled", async () => {
    const { container } = renderApp();

    // Awaiting the skip link both confirms the shell chrome has mounted and lets
    // the auth/health queries settle so the header renders its full content
    // before axe reads it. This is the ONE run where the page-level landmark
    // rules apply — bypass (skip link), landmark-one-main (the single <main>)
    // and region (all content within a landmark) are exactly the #200 structure
    // the feature-component helper disables because those screens are not full
    // pages. jsdom still can't do color-contrast; theme-contrast.spec.ts covers
    // that in a real browser.
    await screen.findByRole("link", { name: i18n.t("app.skipToContent") });
    await expectNoShellAxeViolations(container);
  });
});
