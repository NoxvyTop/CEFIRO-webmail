import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./i18n";
import i18n from "./i18n";
import { AppErrorBoundary } from "./AppErrorBoundary";

// GH #345: routes.tsx's `errorElement` (see RouteError.tsx) only catches
// errors thrown while rendering a route — nothing thrown outside the
// router's own tree (e.g. during RouterProvider's own render) was ever
// caught, and main.tsx had no boundary of its own either.
function Boom(): never {
  throw new Error("boom");
}

describe("AppErrorBoundary (GH #345)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error to console.error twice by default; this
    // test is about the fallback UI, not about that expected noise.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <p>all good</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("catches a render error and shows the generic fallback with a reload action", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toBe(i18n.t("app.routeError.genericTitle"));
    expect(
      screen.getByRole("button", { name: i18n.t("app.routeError.reload") }),
    ).toBeInTheDocument();
  });
});
