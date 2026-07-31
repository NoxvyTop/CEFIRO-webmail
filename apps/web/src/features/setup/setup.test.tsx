import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import { routes } from "../../app/routes";

function renderSetup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ["/setup"] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("setup page", () => {
  it("asks for the console token first", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderSetup();
    // SetupPage is a lazily-loaded route chunk, so its first paint resolves
    // through Suspense — await the initial content instead of reading it sync.
    expect(await screen.findByText("Configuración inicial")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña temporal de consola")).toBeInTheDocument();
  });

  it("shows disabled message on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
    );
    renderSetup();
    fireEvent.change(await screen.findByLabelText("Contraseña temporal de consola"), {
      target: { value: "tok" },
    });
    fireEvent.click(screen.getByText("Conectar"));
    expect(
      await screen.findByText("El modo de configuración está desactivado"),
    ).toBeInTheDocument();
  });

  it("connects and sends the sso form with the token header", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) {
        return new Response(
          JSON.stringify({ bootstrapMode: true, ssoConfigured: false, userCount: 0 }),
        );
      }
      if (path.includes("/api/setup/sso")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    fireEvent.change(await screen.findByLabelText("Contraseña temporal de consola"), {
      target: { value: "console-token" },
    });
    fireEvent.click(screen.getByText("Conectar"));
    await screen.findByText("Proveedor SSO (OIDC)");

    fireEvent.change(screen.getByLabelText("Issuer"), {
      target: { value: "https://auth.noxvytop.com" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "webmail" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "secret-1" } });
    fireEvent.click(screen.getByText("Guardar"));

    await waitFor(() => {
      const ssoCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/setup/sso"));
      expect(ssoCall).toBeTruthy();
      const init = ssoCall![1] as RequestInit;
      expect((init.headers as Record<string, string>)["x-setup-token"]).toBe("console-token");
    });
    expect(await screen.findByText("Guardado")).toBeInTheDocument();
  });
});
