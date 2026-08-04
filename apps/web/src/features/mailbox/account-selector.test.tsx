import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, useSearchParams } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import { AccountSelector } from "./AccountSelector";

function stubSharedAccounts(accounts: Array<{ id: string; name: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(accounts))),
  );
}

// Renders the selector plus a probe that exposes the live search string, so a
// switch's effect on the URL is observable without a real browser.
function Harness() {
  const [searchParams] = useSearchParams();
  return (
    <>
      <AccountSelector />
      <div data-testid="search">{searchParams.toString()}</div>
    </>
  );
}

function renderSelector(initialEntry = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }], {
    initialEntries: [initialEntry],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountSelector", () => {
  it("renders nothing when the member has no shared mailboxes", () => {
    stubSharedAccounts([]);
    renderSelector();
    expect(screen.queryByLabelText("Buzón activo")).toBeNull();
  });

  it("lists the personal mailbox and every shared mailbox", async () => {
    stubSharedAccounts([
      { id: "acc-ventas", name: "Ventas" },
      { id: "acc-soporte", name: "Soporte" },
    ]);
    renderSelector();

    const trigger = await screen.findByRole("button", { name: "Buzón activo" });
    fireEvent.click(trigger);

    expect(screen.getByRole("menuitemradio", { name: "Mi buzón" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Ventas" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Soporte" })).toBeTruthy();
  });

  it("defaults to the personal mailbox and marks it as the selected option", async () => {
    stubSharedAccounts([{ id: "acc-ventas", name: "Ventas" }]);
    renderSelector();

    const trigger = await screen.findByRole("button", { name: "Buzón activo" });
    // The trigger label shows the personal mailbox by default.
    expect(trigger.textContent).toContain("Mi buzón");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Mi buzón" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("switching to a shared mailbox sets the account param and drops the previous view", async () => {
    stubSharedAccounts([{ id: "acc-ventas", name: "Ventas" }]);
    renderSelector("/?mailbox=mb1&thread=t1");

    fireEvent.click(await screen.findByRole("button", { name: "Buzón activo" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Ventas" }));

    const search = screen.getByTestId("search").textContent ?? "";
    const params = new URLSearchParams(search);
    expect(params.get("account")).toBe("acc-ventas");
    expect(params.has("mailbox")).toBe(false);
    expect(params.has("thread")).toBe(false);
  });

  it("switching back to the personal mailbox clears the account param", async () => {
    stubSharedAccounts([{ id: "acc-ventas", name: "Ventas" }]);
    renderSelector("/?account=acc-ventas");

    // The active shared account is reflected in the trigger label.
    const trigger = await screen.findByRole("button", { name: "Buzón activo" });
    expect(trigger.textContent).toContain("Ventas");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Mi buzón" }));

    const params = new URLSearchParams(screen.getByTestId("search").textContent ?? "");
    expect(params.has("account")).toBe(false);
  });

  it("closes the open menu on Escape", async () => {
    stubSharedAccounts([{ id: "acc-ventas", name: "Ventas" }]);
    renderSelector();

    fireEvent.click(await screen.findByRole("button", { name: "Buzón activo" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
