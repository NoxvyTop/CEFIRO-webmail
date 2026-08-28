import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// The "applies locale" test below switches the shared i18n instance to
// "en" — reset it so later tests in this file (or this file's own next run)
// keep asserting the default Spanish copy.
afterEach(async () => {
  await i18n.changeLanguage("es");
  document.documentElement.lang = "es";
});

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
    // A code the server can actually redirect with (GH #232). This used to
    // assert on `unknown_user`, which no route has emitted since JIT
    // provisioning landed — so the one test covering this banner was pinned to
    // a code that could never appear, while `account_archived`, which does,
    // rendered nothing at all.
    renderAt("/?auth_error=account_archived");
    expect(
      await screen.findByText("Tu cuenta está archivada. Pide a un administrador que la reactive."),
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
    expect(await screen.findByText("CÉFIRO")).toBeInTheDocument();
    const avatarButton = await screen.findByRole("button", {
      name: `Sesión iniciada como ${user.email}`,
    });
    fireEvent.click(avatarButton);
    expect(await screen.findByText("Cerrar sesión")).toBeInTheDocument();
  });

  // GH #341: /api/auth/me only ever mapped 401 -> null. A 502/503 (the proxy
  // answering while the backend is down) fell through to
  // sessionUserSchema.parse(await res.json()), threw, and after retries
  // RequireAuth rendered the login screen — as if credentials were the
  // problem, when the service itself was unreachable.
  it("shows a service-unavailable state (not the login screen) when /me fails with a non-401 status, and retries", async () => {
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/auth/me")) {
          meCalls += 1;
          if (meCalls === 1) return new Response("{}", { status: 502 });
          return new Response(JSON.stringify(user));
        }
        return new Response(JSON.stringify({ status: "ok", checks: {} }));
      }),
    );
    renderAt("/");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(i18n.t("auth.serviceUnavailable.title"));
    // Not the login screen — a 502 is not a rejected credential.
    expect(screen.queryByText(i18n.t("auth.signIn", { provider: "SSO" }))).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("auth.serviceUnavailable.retry") }));

    expect(await screen.findByText("CÉFIRO")).toBeInTheDocument();
  });

  // #348: i18n.ts always initialized in "es" and nothing ever applied the
  // session user's own `locale`, so an English-preference user still got a
  // Spanish UI. Loading a session with locale "en" must switch the active
  // language and the document's lang attribute.
  it("applies the session user's locale once /me resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/auth/me")) {
          return new Response(JSON.stringify({ ...user, locale: "en" }));
        }
        return new Response(JSON.stringify({ status: "ok", checks: {} }));
      }),
    );
    renderAt("/");
    expect(await screen.findByText("CÉFIRO")).toBeInTheDocument();
    const avatarButton = await screen.findByRole("button", {
      name: `Signed in as ${user.email}`,
    });
    fireEvent.click(avatarButton);
    expect(await screen.findByText("Sign out")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("redirects unknown routes to the home page", async () => {
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
    renderAt("/no-existe");
    expect(await screen.findByText("CÉFIRO")).toBeInTheDocument();
    const avatarButton = await screen.findByRole("button", {
      name: `Sesión iniciada como ${user.email}`,
    });
    fireEvent.click(avatarButton);
    expect(await screen.findByText("Cerrar sesión")).toBeInTheDocument();
  });
});
