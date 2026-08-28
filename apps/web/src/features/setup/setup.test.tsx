import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import i18n from "../../app/i18n";
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

const TOKEN_LABEL = "Contraseña temporal de consola";

// Connects with a valid token and lands on the connected phase, so a test that
// exercises the SSO/user steps does not have to re-type the token dance.
async function connectAt(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn().mockImplementation(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  renderSetup();
  fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), { target: { value: "console-token" } });
  fireEvent.click(screen.getByText("Conectar"));
  await screen.findByText("Nuevo usuario");
  return fetchMock;
}

const CONNECTED_STATUS = JSON.stringify({
  bootstrapMode: true,
  ssoConfigured: false,
  userCount: 0,
});

describe("setup page", () => {
  it("asks for the console token first", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderSetup();
    // SetupPage is a lazily-loaded route chunk, so its first paint resolves
    // through Suspense — await the initial content instead of reading it sync.
    expect(await screen.findByText("Configuración inicial")).toBeInTheDocument();
    expect(screen.getByLabelText(TOKEN_LABEL)).toBeInTheDocument();
  });

  it("shows disabled message on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
    );
    renderSetup();
    fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), {
      target: { value: "tok" },
    });
    fireEvent.click(screen.getByText("Conectar"));
    expect(
      await screen.findByText("El modo de configuración está desactivado"),
    ).toBeInTheDocument();
  });

  // #348: the wizard interpolated the raw English literals "yes"/"no" into
  // the status line, and left the role/locale <option> labels as untranslated
  // English words ("employee", "admin", "es", "en") regardless of locale.
  it("localizes the sso status line and the role/locale option labels", async () => {
    await connectAt(async (input) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      return new Response("{}", { status: 404 });
    });

    expect(screen.getByText("SSO configurado: No — Usuarios: 0")).toBeInTheDocument();

    const roleSelect = screen.getByLabelText("Rol") as HTMLSelectElement;
    const roleOptionLabels = Array.from(roleSelect.options).map((option) => option.textContent);
    expect(roleOptionLabels).toEqual(["Empleado", "Administrador"]);

    const localeSelect = screen.getByLabelText("Idioma") as HTMLSelectElement;
    const localeOptionLabels = Array.from(localeSelect.options).map((option) => option.textContent);
    expect(localeOptionLabels).toEqual(["Español", "Inglés"]);
  });

  it("connects and sends the sso form with the token header", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) {
        return new Response(CONNECTED_STATUS);
      }
      if (path.includes("/api/setup/sso")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), {
      target: { value: "console-token" },
    });
    fireEvent.click(screen.getByText("Conectar"));
    await screen.findByText("Proveedor SSO (OIDC)");

    fireEvent.change(screen.getByLabelText("Issuer"), {
      target: { value: "https://auth.noxvytop.com" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "webmail" } });
    const clientSecretInput = screen.getByLabelText("Client Secret");
    // #348: not a login credential — the browser must not offer to save this
    // as a password, nor autofill an unrelated saved password into it.
    expect(clientSecretInput).toHaveAttribute("autocomplete", "off");
    fireEvent.change(clientSecretInput, { target: { value: "secret-1" } });
    fireEvent.click(screen.getByText("Guardar"));

    await waitFor(() => {
      const ssoCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/setup/sso"));
      expect(ssoCall).toBeTruthy();
      const init = ssoCall![1] as RequestInit;
      expect((init.headers as Record<string, string>)["x-setup-token"]).toBe("console-token");
    });
    expect(await screen.findByText("Guardado")).toBeInTheDocument();
  });

  // #290: the optional provider-name field is sent in the SSO save body.
  it("submits the configured provider name with the sso form", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      if (path.includes("/api/setup/sso")) return new Response(JSON.stringify({ ok: true }));
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), {
      target: { value: "console-token" },
    });
    fireEvent.click(screen.getByText("Conectar"));
    await screen.findByText("Proveedor SSO (OIDC)");

    fireEvent.change(screen.getByLabelText("Issuer"), {
      target: { value: "https://auth.noxvytop.com" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "webmail" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "secret-1" } });
    fireEvent.change(screen.getByLabelText("Nombre del proveedor"), {
      target: { value: "Authentik" },
    });
    fireEvent.click(screen.getByText("Guardar"));

    await waitFor(() => {
      const ssoCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/setup/sso"));
      expect(ssoCall).toBeTruthy();
      expect(JSON.parse((ssoCall![1] as RequestInit).body as string).providerName).toBe("Authentik");
    });
  });

  // GH #271: the mute entry point. A rejected token used to drop the operator
  // back onto the same form with no explanation at all.
  it("shows a clear error and marks the token field invalid when the token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 })),
    );
    renderSetup();
    const tokenInput = await screen.findByLabelText(TOKEN_LABEL);
    fireEvent.change(tokenInput, { target: { value: "wrong" } });
    fireEvent.click(screen.getByText("Conectar"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("setup.errors.unauthorized"));
    expect(tokenInput).toHaveAttribute("aria-invalid", "true");
    expect(tokenInput).toHaveAttribute("aria-describedby", "setup-token-error");

    // Editing the token clears the failed state so the next attempt starts clean.
    fireEvent.change(tokenInput, { target: { value: "wrong-again" } });
    expect(tokenInput).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to a generic error when the rejection carries no readable code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
    );
    renderSetup();
    fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Conectar"));

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("setup.errors.generic"));
  });

  it("reports a network failure when connect cannot reach the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderSetup();
    fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Conectar"));

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("setup.errors.network_error"));
  });

  it("disables Conectar and shows a connecting label while verifying, ignoring a double submit", async () => {
    let resolveStatus: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          if (String(input).includes("/api/setup/status")) resolveStatus = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    const tokenInput = await screen.findByLabelText(TOKEN_LABEL);
    const form = tokenInput.closest("form")!;
    fireEvent.change(tokenInput, { target: { value: "tok" } });
    fireEvent.submit(form);

    const connecting = await screen.findByText(i18n.t("setup.connecting"));
    expect(connecting.closest("button")).toBeDisabled();

    // A second submit while the first is in flight must not fire a second request.
    fireEvent.submit(form);
    const statusCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/setup/status"),
    );
    expect(statusCalls).toHaveLength(1);

    resolveStatus(new Response(CONNECTED_STATUS));
    expect(await screen.findByText("Proveedor SSO (OIDC)")).toBeInTheDocument();
  });

  it("surfaces user_exists and marks the email field invalid when creating a duplicate user", async () => {
    const fetchMock = await connectAt(async (input) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      if (path.includes("/api/setup/users")) {
        return new Response(JSON.stringify({ code: "user_exists" }), { status: 409 });
      }
      return new Response("{}", { status: 404 });
    });

    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "dupe@noxvytop.com" } });
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Dupe" } });
    fireEvent.change(screen.getByLabelText("Contraseña del buzón"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByText("Crear"));

    const emailInput = screen.getByLabelText("Correo");
    await waitFor(() => expect(emailInput).toHaveAttribute("aria-invalid", "true"));
    expect(emailInput).toHaveAttribute("aria-describedby", "setup-user-error");
    expect(document.getElementById("setup-user-error")).toHaveTextContent(
      i18n.t("setup.errors.user_exists"),
    );

    const userCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/setup/users"));
    expect((userCall![1] as RequestInit).method).toBe("POST");
  });

  it("creates a user and confirms it", async () => {
    await connectAt(async (input) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      if (path.includes("/api/setup/users")) {
        return new Response(JSON.stringify({ id: "u1", email: "new@noxvytop.com" }));
      }
      return new Response("{}", { status: 404 });
    });

    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "new@noxvytop.com" } });
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Contraseña del buzón"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByText("Crear"));

    expect(await screen.findByText("Usuario creado")).toBeInTheDocument();
  });

  it("rejects invalid user data before calling the server", async () => {
    const fetchMock = await connectAt(async (input) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      return new Response("{}", { status: 404 });
    });

    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "who@noxvytop.com" } });
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Who" } });
    // Mailbox password below the 8-char minimum: safeParse fails client-side.
    fireEvent.change(screen.getByLabelText("Contraseña del buzón"), { target: { value: "short" } });
    fireEvent.click(screen.getByText("Crear"));

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("setup.errors.invalid_body"));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/setup/users"))).toBe(false);
  });

  it("reports invalid SSO data before calling the server", async () => {
    const fetchMock = await connectAt(async (input) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      return new Response("{}", { status: 404 });
    });

    // Issuer is blank, so the SSO schema (issuer must be a URL) fails locally.
    fireEvent.click(screen.getByText("Guardar"));

    await waitFor(() =>
      expect(screen.getByText(i18n.t("setup.errors.invalid_body"))).toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/setup/sso"))).toBe(false);
  });

  it("surfaces a server error when saving SSO fails", async () => {
    await connectAt(async (input) => {
      const path = String(input);
      if (path.includes("/api/setup/status")) return new Response(CONNECTED_STATUS);
      if (path.includes("/api/setup/sso")) {
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      }
      return new Response("{}", { status: 404 });
    });

    fireEvent.change(screen.getByLabelText("Issuer"), {
      target: { value: "https://auth.noxvytop.com" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "webmail" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "secret-1" } });
    fireEvent.click(screen.getByText("Guardar"));

    // "internal" has no setup message of its own, so it degrades to generic.
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("setup.errors.generic"));
  });
});
