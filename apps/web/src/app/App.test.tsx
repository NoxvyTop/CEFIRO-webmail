import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "./i18n";
import { App } from "./App";

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("shows the app title in Spanish and health status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", checks: { postgres: true } })),
      ),
    );
    renderApp();
    expect(screen.getByText("Correo NoxvyTop")).toBeInTheDocument();
    expect(await screen.findByText("Servicio operativo")).toBeInTheDocument();
  });
});
