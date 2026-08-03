import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { AdminSsoView } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";

const {
  fetchAdminUsers, fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
} = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  fetchAdminSso: vi.fn(),
  updateAdminSso: vi.fn(),
  fetchAdminInstance: vi.fn().mockResolvedValue({ sentWithFooter: false }),
  updateAdminInstance: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchAdminUsers,
  createAdminUser: vi.fn(),
  setUserRole: vi.fn(),
  setUserActive: vi.fn(),
  setUserCredential: vi.fn(),
  fetchAdminSso,
  updateAdminSso,
  fetchAdminInstance,
  updateAdminInstance,
}));

const configuredSso: AdminSsoView = {
  configured: true,
  issuer: "https://auth.test",
  clientId: "webmail",
  scopes: "openid email",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.sso") }));
  return client;
}

describe("AdminPage SSO config panel", () => {
  it("shows configured status and issuer, with the client secret input left empty", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue(configuredSso);
    renderPage();

    expect(await screen.findByText(i18n.t("admin.sso.configured"))).toBeInTheDocument();
    expect(screen.getByText("https://auth.test")).toBeInTheDocument();

    const secretInput = screen.getByLabelText("Client Secret") as HTMLInputElement;
    expect(secretInput).toHaveAttribute("type", "password");
    expect(secretInput.value).toBe("");
  });

  it("shows the not-configured status when sso is not set up", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue({
      configured: false, issuer: null, clientId: null, scopes: null,
    });
    renderPage();

    expect(await screen.findByText(i18n.t("admin.sso.notConfigured"))).toBeInTheDocument();
  });

  it("submits the form and PUTs the entered values including clientSecret, showing saved on success", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue(configuredSso);
    updateAdminSso.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText(i18n.t("admin.sso.configured"));

    fireEvent.change(screen.getByLabelText("Issuer"), { target: { value: "https://new-issuer.test" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "new-client" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "s3cr3t" } });
    fireEvent.change(screen.getByLabelText("Scopes"), { target: { value: "openid profile" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.sso.save") }));

    await waitFor(() => expect(updateAdminSso).toHaveBeenCalledWith({
      issuer: "https://new-issuer.test",
      clientId: "new-client",
      clientSecret: "s3cr3t",
      scopes: "openid profile",
    }));

    expect(await screen.findByText(i18n.t("admin.sso.saved"))).toBeInTheDocument();
  });

  // GH #282: an invalid/empty issuer used to reach the server and come back as a
  // single fixed "could not save" with no clue which field was wrong. The issuer
  // is now validated at the field (mirroring the server's `z.string().url()`),
  // so the doomed request is never sent and the hint names the field.
  it("shows a per-field hint for an invalid issuer without sending the request", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue(configuredSso);
    // This file has no beforeEach reset, so clear the shared spy's prior calls.
    updateAdminSso.mockClear();
    renderPage();

    await screen.findByText(i18n.t("admin.sso.configured"));
    fireEvent.change(screen.getByLabelText("Issuer"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.sso.save") }));

    expect(await screen.findByText(i18n.t("admin.sso.errors.issuerInvalid"))).toBeInTheDocument();
    expect(updateAdminSso).not.toHaveBeenCalled();
  });

  // GH #282: a server rejection now resolves through the per-code map, and the
  // form — the client secret above all — survives the failure, so fixing one
  // field does not mean re-typing the secret.
  it("shows the server error by code and keeps the client secret on failure", async () => {
    const { MailApiError } = await import("../mailbox/api");
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue(configuredSso);
    updateAdminSso.mockRejectedValue(new MailApiError(400, "invalid_body"));
    renderPage();

    await screen.findByText(i18n.t("admin.sso.configured"));
    fireEvent.change(screen.getByLabelText("Issuer"), { target: { value: "https://auth.test" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "webmail" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "s3cr3t" } });
    fireEvent.change(screen.getByLabelText("Scopes"), { target: { value: "openid email" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.sso.save") }));

    expect(await screen.findByText(i18n.t("admin.errors.invalid_body"))).toBeInTheDocument();
    const secret = screen.getByLabelText("Client Secret") as HTMLInputElement;
    expect(secret.value).toBe("s3cr3t");
  });
});
