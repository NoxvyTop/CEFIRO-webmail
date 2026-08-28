import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import "./i18n";
import i18n from "./i18n";
import { RouteError } from "./RouteError";

// GH #345: routes had no `errorElement`, so a dynamic-import failure (stale
// hashed chunk after a deploy) or any other render-time throw fell through to
// react-router's built-in English "Unexpected Application Error!" page.
function renderWithError(error: unknown) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <ThrowingRoute error={error} />,
        errorElement: <RouteError />,
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

function ThrowingRoute({ error }: { error: unknown }): never {
  throw error;
}

describe("RouteError (GH #345)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a reload for a dynamic-import failure, framed as a new version being available", () => {
    renderWithError(new TypeError("Failed to fetch dynamically imported module"));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(i18n.t("app.routeError.staleTitle"));
    expect(screen.getByText(i18n.t("app.routeError.staleDescription"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("app.routeError.reload") }),
    ).toBeInTheDocument();
  });

  it("recognises the plain fetch failure a stale chunk 404 can also surface as", () => {
    renderWithError(new TypeError("Failed to fetch"));

    expect(screen.getByRole("alert").textContent).toBe(i18n.t("app.routeError.staleTitle"));
  });

  it("shows the generic fallback for any other error, still with a reload action", () => {
    renderWithError(new Error("Cannot read properties of null"));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(i18n.t("app.routeError.genericTitle"));
    expect(screen.getByText(i18n.t("app.routeError.genericDescription"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("app.routeError.reload") }),
    ).toBeInTheDocument();
  });

  it("reloads the page when the button is clicked", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderWithError(new Error("boom"));

    screen.getByRole("button", { name: i18n.t("app.routeError.reload") }).click();

    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
