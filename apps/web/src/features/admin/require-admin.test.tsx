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

function stubMe(response: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) {
        return new Response(JSON.stringify(response), { status });
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

const adminUser = {
  userId: "u1",
  email: "admin@noxvytop.com",
  displayName: "Admin",
  role: "admin",
  locale: "es",
};

const employeeUser = {
  userId: "u2",
  email: "emp@noxvytop.com",
  displayName: "Emp",
  role: "employee",
  locale: "es",
};

describe("RequireAdmin", () => {
  it("renders the admin page for an admin user", async () => {
    stubMe(adminUser);
    renderAt("/admin");
    expect(await screen.findByRole("heading", { name: "Administración" })).toBeInTheDocument();
  });

  it("shows a forbidden alert for a non-admin user", async () => {
    stubMe(employeeUser);
    renderAt("/admin");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No tenés permisos de administrador");
    expect(screen.queryByText("Administración")).not.toBeInTheDocument();
  });

  it("shows the login screen when /me returns 401", async () => {
    stubMe({}, 401);
    renderAt("/admin");
    expect(await screen.findByText("Iniciar sesión con SSO")).toBeInTheDocument();
  });
});
