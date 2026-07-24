import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";

const {
  fetchAdminUsers, fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
} = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  fetchAdminSso: vi.fn(),
  updateAdminSso: vi.fn(),
  fetchAdminInstance: vi.fn(),
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.settings") }));
  return client;
}

describe("AdminPage instance settings panel (GH #86)", () => {
  it("reflects the fetched value: unchecked when sentWithFooter is false (default-off)", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue({ configured: false, issuer: null, clientId: null, scopes: null });
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    const toggle = await screen.findByLabelText(i18n.t("admin.settings.footer.label"));
    expect(toggle).toHaveAttribute("type", "checkbox");
    expect(toggle).not.toBeChecked();
  });

  it("reflects the fetched value: checked when sentWithFooter is true", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue({ configured: false, issuer: null, clientId: null, scopes: null });
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: true });
    renderPage();

    const toggle = await screen.findByLabelText(i18n.t("admin.settings.footer.label"));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("toggling the checkbox PUTs the new value and reflects the refetched value on success", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue({ configured: false, issuer: null, clientId: null, scopes: null });
    fetchAdminInstance
      .mockResolvedValueOnce({ sentWithFooter: false })
      .mockResolvedValueOnce({ sentWithFooter: true });
    updateAdminInstance.mockResolvedValue(undefined);
    renderPage();

    const toggle = await screen.findByLabelText(i18n.t("admin.settings.footer.label"));
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(updateAdminInstance).toHaveBeenCalledWith({ sentWithFooter: true }));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("shows an error message when saving fails", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    fetchAdminSso.mockResolvedValue({ configured: false, issuer: null, clientId: null, scopes: null });
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    updateAdminInstance.mockRejectedValue(new Error("boom"));
    renderPage();

    const toggle = await screen.findByLabelText(i18n.t("admin.settings.footer.label"));
    fireEvent.click(toggle);

    expect(await screen.findByText(i18n.t("admin.errors.action"))).toBeInTheDocument();
  });
});
