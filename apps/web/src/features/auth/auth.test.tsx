import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

const user = {
  userId: "u1",
  email: "emp@noxvytop.com",
  displayName: "Emp",
  role: "employee",
  locale: "es",
};

describe("auth flow", () => {
  it("shows the login screen when /me returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    );
    renderAt("/");
    expect(await screen.findByText("Iniciar sesión con SSO")).toBeInTheDocument();
  });

  it("shows the auth error from the query string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    );
    renderAt("/?auth_error=unknown_user");
    expect(
      await screen.findByText("Tu cuenta no está registrada en el correo"),
    ).toBeInTheDocument();
  });

  it("shows the home shell when /me returns a user", async () => {
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
    renderAt("/");
    expect(await screen.findByText("Correo NoxvyTop")).toBeInTheDocument();
    expect(await screen.findByText("Cerrar sesión")).toBeInTheDocument();
  });
});
