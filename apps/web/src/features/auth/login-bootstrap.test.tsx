import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import { routes } from "../../app/routes";

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function stubFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      for (const [match, handler] of Object.entries(handlers)) {
        if (path.includes(match)) return handler();
      }
      throw new Error(`Unhandled fetch: ${path} ${init ? JSON.stringify(init) : ""}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login screen bootstrap form", () => {
  it("shows the emergency form when bootstrapMode is true", async () => {
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
      "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: true })),
    });
    renderAt("/");

    expect(await screen.findByLabelText("Usuario")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });

  it("does not show the emergency form when bootstrapMode is false", async () => {
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
      "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: false })),
    });
    renderAt("/");

    expect(await screen.findByText("Iniciar sesión con SSO")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña")).not.toBeInTheDocument();
  });

  it("submits the emergency form to /api/auth/bootstrap", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      if (path.includes("/api/auth/mode")) {
        return new Response(JSON.stringify({ bootstrapMode: true }));
      }
      if (path.includes("/api/auth/me")) {
        return new Response("{}", { status: 401 });
      }
      throw new Error(`Unhandled fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("/");

    const emailInput = await screen.findByLabelText("Usuario");
    const passwordInput = screen.getByLabelText("Contraseña");
    fireEvent.change(emailInput, { target: { value: "admin@noxvytop.com" } });
    fireEvent.change(passwordInput, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    await vi.waitFor(() => {
      const bootstrapCall = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/api/auth/bootstrap"),
      );
      expect(bootstrapCall).toBeTruthy();
      const init = bootstrapCall?.[1] as RequestInit | undefined;
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        email: "admin@noxvytop.com",
        password: "s3cret",
      });
    });
  });
});
