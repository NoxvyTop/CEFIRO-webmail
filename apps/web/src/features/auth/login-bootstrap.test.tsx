import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
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

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login screen bootstrap form", () => {
  it("shows only the emergency form when bootstrapMode is true", async () => {
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
      "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: true })),
    });
    renderAt("/");

    expect(await screen.findByLabelText("Usuario")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.queryByText("Iniciar sesión con SSO")).not.toBeInTheDocument();
  });

  it("shows the SSO action and the disabled-credentials notice when bootstrapMode is false", async () => {
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
      "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: false })),
    });
    renderAt("/");

    expect(await screen.findByText("Iniciar sesión con SSO")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Usuario")).not.toBeInTheDocument();
    expect(screen.queryByText("Acceso de emergencia")).not.toBeInTheDocument();
    expect(await screen.findByText(i18n.t("auth.credentialsDisabled"))).toBeInTheDocument();
  });

  it("does not flash the disabled-credentials notice while the mode is still loading", async () => {
    let resolveMode: (response: Response) => void = () => {};
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/auth/me")) return new Response("{}", { status: 401 });
        if (path.includes("/api/auth/mode")) {
          return new Promise<Response>((resolve) => {
            resolveMode = resolve;
          });
        }
        throw new Error(`Unhandled fetch: ${path}`);
      }),
    );
    renderAt("/");

    // SSO renders immediately (mode undefined !== true), but the notice must
    // wait for an explicit bootstrapMode: false — never shown speculatively.
    expect(await screen.findByText("Iniciar sesión con SSO")).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("auth.credentialsDisabled"))).not.toBeInTheDocument();

    resolveMode(new Response(JSON.stringify({ bootstrapMode: false })));
    expect(await screen.findByText(i18n.t("auth.credentialsDisabled"))).toBeInTheDocument();
  });

  it("shows a Conectando… state and the redirecting hint after clicking SSO, then redirects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const originalLocation = window.location;
    // jsdom throws "Not implemented: navigation" on a real href assignment;
    // swap in a plain writable object so the delayed redirect can be observed.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "" },
    });

    try {
      stubFetch({
        "/api/auth/me": () => new Response("{}", { status: 401 }),
        "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: false })),
      });
      renderAt("/");

      const ssoLink = await screen.findByText("Iniciar sesión con SSO");
      fireEvent.click(ssoLink);

      expect(await screen.findByText(i18n.t("auth.connecting"))).toBeInTheDocument();
      expect(await screen.findByText(i18n.t("auth.redirecting"))).toBeInTheDocument();
      expect(window.location.href).toBe("");

      await vi.advanceTimersByTimeAsync(1400);

      expect(window.location.href).toBe("/api/auth/login");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
      vi.useRealTimers();
    }
  });

  it("validates the emergency form inline before submitting", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
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
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText(i18n.t("auth.bootstrap.errors.emptyUser"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("auth.bootstrap.errors.emptyPassword"))).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/bootstrap"))).toBe(false);

    // The real bootstrap username has no "@" — it must clear the error, not
    // trigger a new one. This is the regression this suite guards against
    // (CLARO-06/OSCURO-02): "Usuario" is not an email field.
    fireEvent.change(emailInput, { target: { value: "bootstrap-admin" } });
    fireEvent.change(passwordInput, { target: { value: "s3cret" } });

    expect(screen.queryByText(i18n.t("auth.bootstrap.errors.emptyUser"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("auth.bootstrap.errors.emptyPassword"))).not.toBeInTheDocument();
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
    // "bootstrap-admin" is the real emergency username (no "@") — it must
    // pass client validation and reach the server unchanged.
    fireEvent.change(emailInput, { target: { value: "bootstrap-admin" } });
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
        email: "bootstrap-admin",
        password: "s3cret",
      });
    });
  });

  it("shows the throttled message when the emergency login is rate-limited (429)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/bootstrap")) {
        return new Response(JSON.stringify({ code: "too_many_requests" }), {
          status: 429,
          headers: { "retry-after": "60" },
        });
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

    fireEvent.change(await screen.findByLabelText("Usuario"), {
      target: { value: "bootstrap-admin" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(
      await screen.findByText(i18n.t("auth.bootstrap.errors.too_many_requests")),
    ).toBeInTheDocument();
    // A throttled attempt must not read as a wrong credential.
    expect(screen.queryByText(i18n.t("auth.bootstrap.error"))).not.toBeInTheDocument();
  });

  it("shows the generic invalid-credential message on a rejected login (401)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/bootstrap")) {
        return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 });
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

    fireEvent.change(await screen.findByLabelText("Usuario"), {
      target: { value: "bootstrap-admin" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText(i18n.t("auth.bootstrap.error"))).toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t("auth.bootstrap.errors.too_many_requests")),
    ).not.toBeInTheDocument();
  });

  it("announces empty-field errors as alerts and wires them to their inputs for screen readers", async () => {
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
      "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: true })),
    });
    renderAt("/");

    const emailInput = await screen.findByLabelText("Usuario");
    const passwordInput = screen.getByLabelText("Contraseña");
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    // Both field errors must be exposed as live alerts so a screen reader
    // announces them instead of leaving the failed submit silent.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(2);

    expect(emailInput).toHaveAttribute("aria-invalid", "true");
    expect(emailInput).toHaveAttribute("aria-describedby", "bootstrap-email-error");
    const emailError = document.getElementById("bootstrap-email-error");
    expect(emailError).toHaveAttribute("role", "alert");
    expect(emailError).toHaveTextContent(i18n.t("auth.bootstrap.errors.emptyUser"));

    expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput).toHaveAttribute("aria-describedby", "bootstrap-password-error");
    const passwordError = document.getElementById("bootstrap-password-error");
    expect(passwordError).toHaveAttribute("role", "alert");
    expect(passwordError).toHaveTextContent(i18n.t("auth.bootstrap.errors.emptyPassword"));

    // Clearing the fields drops both the alert and the aria-invalid wiring.
    fireEvent.change(emailInput, { target: { value: "bootstrap-admin" } });
    expect(emailInput).not.toHaveAttribute("aria-invalid");
    expect(emailInput).not.toHaveAttribute("aria-describedby");
  });

  it("announces a rejected credential as an alert", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/bootstrap")) {
        return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 });
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

    fireEvent.change(await screen.findByLabelText("Usuario"), {
      target: { value: "bootstrap-admin" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("auth.bootstrap.error"));
  });

  it("renders a discreet theme toggle and switches themes when clicked", async () => {
    stubFetch({
      "/api/auth/me": () => new Response("{}", { status: 401 }),
      "/api/auth/mode": () => new Response(JSON.stringify({ bootstrapMode: true })),
    });
    renderAt("/");

    await screen.findByLabelText("Usuario");

    // No stored preference and no matchMedia in jsdom: useTheme resolves the
    // brand default "light", so the toggle's accessible name offers night.
    const toggle = await screen.findByRole("button", { name: i18n.t("app.themeNight") });
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBe("night");
    expect(await screen.findByRole("button", { name: i18n.t("app.themeLight") })).toBeInTheDocument();
  });
});
