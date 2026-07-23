import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "./i18n";
import i18n from "./i18n";
import { routes } from "./routes";

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
