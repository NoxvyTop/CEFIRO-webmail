import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// GH #345: there was no offline signal in the UI at all — a lost connection
// looked identical to a slow one until every in-flight request failed on
// its own.
describe("App offline banner (GH #345)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // GH #345: dispatching a real "offline"/"online" event on window is also
    // exactly what @tanstack/react-query's own onlineManager listens for
    // globally (a singleton shared by every QueryClient in the process) — an
    // assertion failure mid-test that skips the "online" dispatch below would
    // otherwise leave every LATER test's queries thinking the browser is
    // offline (paused, never fetching), which showed up as unrelated tests
    // timing out for no visible reason. Always force it back regardless of
    // how the test ended.
    onlineManager.setOnline(true);
  });

  it("shows a banner while offline and hides it again once back online", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    renderApp();
    await screen.findByText("CÉFIRO");

    expect(screen.queryByText(i18n.t("app.offline"))).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(i18n.t("app.offline"))).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(i18n.t("app.offline"))).not.toBeInTheDocument();
  });
});

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

// GH #13/#50 (G-4): the header lost its shared-mailbox selector and its
// standalone "Atajos" button — accounts switch from the sidebar's shared page
// now, and "Atajos" lives inside the profile dropdown, opening the same dialog.
describe("App header after the shared-mailboxes refinement", () => {
  it("no longer renders the account selector or a standalone Atajos button in the header", async () => {
    renderApp();

    await screen.findByRole("button", { name: i18n.t("auth.signedInAs", { email: user.email }) });
    // The old "Buzón activo" account selector is gone from the header.
    expect(screen.queryByRole("button", { name: i18n.t("accounts.selectorLabel") })).toBeNull();
    // With the profile menu closed, there is no "Atajos" control anywhere — the
    // standalone header button is gone and the menu item is not yet mounted.
    expect(screen.queryByRole("button", { name: i18n.t("shortcuts.title") })).toBeNull();
  });

  it("opens the shortcuts dialog from the Atajos item inside the profile dropdown", async () => {
    renderApp();

    const avatar = await screen.findByRole("button", {
      name: i18n.t("auth.signedInAs", { email: user.email }),
    });
    fireEvent.click(avatar);

    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("shortcuts.title") }));

    expect(
      await screen.findByRole("dialog", { name: i18n.t("shortcuts.overlayTitle") }),
    ).toBeInTheDocument();
  });
});

// #348: h-screen resolves against the LARGE viewport on iOS Safari, which
// includes the area the address/toolbar chrome covers before it collapses on
// scroll — so the shell was taller than the space actually visible on first
// paint, with the header/footer clipped by the toolbar. h-dvh tracks the
// dynamic viewport (shrinks/grows with the chrome) instead.
describe("App shell viewport height", () => {
  it("sizes the shell with the dynamic viewport unit, not h-screen", async () => {
    renderApp();
    await screen.findByRole("button", { name: i18n.t("auth.signedInAs", { email: user.email }) });

    expect(document.querySelector(".flex.flex-col.h-dvh")).not.toBeNull();
    expect(document.querySelector(".h-screen")).toBeNull();
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

// GH #342: the health query used to run exactly once (mount), so a backend
// that degraded mid-session never surfaced "Servicio degradado" — the banner
// only ever reflected the state at page load.
describe("App health check polling (GH #342)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls /api/health every 60s so a mid-session outage can surface", async () => {
    vi.useFakeTimers();
    let healthCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/auth/me")) return new Response(JSON.stringify(user));
        if (path.includes("/api/health")) {
          healthCalls += 1;
          const status = healthCalls === 1 ? "ok" : "degraded";
          return new Response(JSON.stringify({ status, checks: {} }));
        }
        return new Response(JSON.stringify({}));
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await act(async () => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    });
    expect(screen.queryByText(i18n.t("health.degraded"))).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    });

    // Not findByText/waitFor: those poll via a real setTimeout, which never
    // fires once fake timers own the clock and nothing advances them further.
    expect(healthCalls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(i18n.t("health.degraded"))).toBeInTheDocument();
  });
});
