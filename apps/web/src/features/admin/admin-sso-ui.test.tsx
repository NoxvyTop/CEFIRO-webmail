import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AdminSsoView } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";

const {
  fetchAdminUsers, fetchAdminSso, updateAdminSso,
} = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  fetchAdminSso: vi.fn(),
  updateAdminSso: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchAdminUsers,
  createAdminUser: vi.fn(),
  setUserRole: vi.fn(),
  setUserActive: vi.fn(),
  setUserCredential: vi.fn(),
  fetchAdminSso,
  updateAdminSso,
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

  it("shows an error message when saving fails", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue(configuredSso);
    updateAdminSso.mockRejectedValue(new Error("boom"));
    renderPage();

    await screen.findByText(i18n.t("admin.sso.configured"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.sso.save") }));

    expect(await screen.findByText(i18n.t("admin.sso.error"))).toBeInTheDocument();
  });
});
