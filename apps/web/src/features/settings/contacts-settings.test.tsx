import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { Contact } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";
import { ContactsSettings } from "./ContactsSettings";

const { fetchContacts, createContact, deleteContact, promoteContact } = vi.hoisted(() => ({
  fetchContacts: vi.fn(),
  createContact: vi.fn(),
  deleteContact: vi.fn(),
  promoteContact: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock("../contacts/api", () => ({ fetchContacts, createContact, deleteContact, promoteContact }));

const ana: Contact = { id: "c1", name: "Ana Lopez", email: "ana@example.com", source: "manual" };
const bob: Contact = { id: "c2", name: "Bob Smith", email: "bob@example.com", source: "harvested" };

function renderSettings(contacts: Contact[] = [ana]) {
  fetchContacts.mockResolvedValue(contacts);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContactsSettings />
    </QueryClientProvider>,
  );
  return client;
}

describe("ContactsSettings", () => {
  it("renders the empty state when there are no contacts yet", async () => {
    renderSettings([]);

    expect(await screen.findByText(i18n.t("contacts.empty"))).toBeInTheDocument();
  });

  it("lists existing contacts with their name and email", async () => {
    renderSettings([ana, bob]);

    expect(await screen.findByText("Ana Lopez")).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(screen.getByText("Bob Smith")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("adds a new contact via the form", async () => {
    createContact.mockResolvedValueOnce({ id: "c3", name: "Carla Bosch", email: "carla@example.com", source: "manual" });
    renderSettings([]);

    await screen.findByText(i18n.t("contacts.empty"));
    fireEvent.change(screen.getByLabelText(i18n.t("contacts.name")), { target: { value: "Carla Bosch" } });
    fireEvent.change(screen.getByLabelText(i18n.t("contacts.email")), { target: { value: "carla@example.com" } });

    fetchContacts.mockResolvedValue([{ id: "c3", name: "Carla Bosch", email: "carla@example.com", source: "manual" }]);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("contacts.add") }));

    await waitFor(() => expect(createContact).toHaveBeenCalledWith({ name: "Carla Bosch", email: "carla@example.com" }));
    expect(await screen.findByText("Carla Bosch")).toBeInTheDocument();
    // The form clears after a successful add.
    expect(screen.getByLabelText(i18n.t("contacts.name"))).toHaveValue("");
  });

  it("surfaces a failed add as an alert (contact_exists)", async () => {
    createContact.mockRejectedValueOnce(new MailApiError(409, "contact_exists"));
    renderSettings([]);

    await screen.findByText(i18n.t("contacts.empty"));
    fireEvent.change(screen.getByLabelText(i18n.t("contacts.email")), { target: { value: "dup@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("contacts.add") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.errors.contact_exists"));
  });

  it("requires a confirmation step before deleting a contact, and only deletes after confirming", async () => {
    deleteContact.mockResolvedValueOnce(undefined);
    renderSettings([ana]);

    await screen.findByText("Ana Lopez");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.delete") }));

    // The irreversible consequence must be spelled out before anything happens.
    expect(await screen.findByText(i18n.t("contacts.confirmDeleteQuestion", { name: "Ana Lopez" }))).toBeInTheDocument();
    expect(deleteContact).not.toHaveBeenCalled();

    fetchContacts.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("contacts.confirmDeleteAction") }));

    await waitFor(() => expect(deleteContact).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText(i18n.t("contacts.empty"))).toBeInTheDocument();
  });

  it("cancelling the delete confirmation leaves the contact in place without calling the API", async () => {
    renderSettings([ana]);

    await screen.findByText("Ana Lopez");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.delete") }));
    await screen.findByText(i18n.t("contacts.confirmDeleteQuestion", { name: "Ana Lopez" }));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("contacts.cancelDelete") }));

    expect(screen.queryByText(i18n.t("contacts.confirmDeleteQuestion", { name: "Ana Lopez" }))).not.toBeInTheDocument();
    expect(screen.getByText("Ana Lopez")).toBeInTheDocument();
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it("surfaces a failed delete as an alert", async () => {
    deleteContact.mockRejectedValueOnce(new MailApiError(500, "internal"));
    renderSettings([ana]);

    await screen.findByText("Ana Lopez");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.delete") }));
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("contacts.confirmDeleteAction") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.errors.generic"));
  });

  // GH #163: provenance was stored but never shown, so an address the harvest
  // added on its own was indistinguishable from one the user vetted by hand.
  describe("harvested provenance (#163)", () => {
    it("marks only the auto-harvested contact, inside its own row", async () => {
      renderSettings([ana, bob]);

      await screen.findByText("Ana Lopez");
      const badges = screen.getAllByText(i18n.t("contacts.harvestedBadge"));
      expect(badges).toHaveLength(1);
      expect(badges[0]?.closest("li")).toHaveTextContent("Bob Smith");
    });

    it("offers promotion only for the harvested contact", async () => {
      renderSettings([ana, bob]);

      await screen.findByText("Bob Smith");
      expect(
        screen.getByRole("button", { name: i18n.t("contacts.promoteLabel", { name: "Bob Smith" }) }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: i18n.t("contacts.promoteLabel", { name: "Ana Lopez" }) }),
      ).not.toBeInTheDocument();
    });

    it("promotes a harvested contact and drops the mark once the list refreshes", async () => {
      promoteContact.mockResolvedValueOnce({ ...bob, source: "manual" });
      renderSettings([ana, bob]);

      await screen.findByText("Bob Smith");
      fetchContacts.mockResolvedValue([ana, { ...bob, source: "manual" }]);
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("contacts.promoteLabel", { name: "Bob Smith" }) }),
      );

      await waitFor(() => expect(promoteContact).toHaveBeenCalledWith("c2"));
      await waitFor(() =>
        expect(screen.queryByText(i18n.t("contacts.harvestedBadge"))).not.toBeInTheDocument(),
      );
    });

    it("surfaces a failed promotion as an alert and keeps the contact marked", async () => {
      promoteContact.mockRejectedValueOnce(new MailApiError(404, "not_found"));
      renderSettings([bob]);

      await screen.findByText("Bob Smith");
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("contacts.promoteLabel", { name: "Bob Smith" }) }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.errors.not_found"));
      expect(screen.getByText(i18n.t("contacts.harvestedBadge"))).toBeInTheDocument();
    });
  });
});
