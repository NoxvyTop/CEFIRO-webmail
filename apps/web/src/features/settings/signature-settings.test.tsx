import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { Signature } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";
import { SignatureSettings } from "./SignatureSettings";

const { fetchSignatures, createSignature, updateSignature, deleteSignature } = vi.hoisted(() => ({
  fetchSignatures: vi.fn(),
  createSignature: vi.fn(),
  updateSignature: vi.fn(),
  deleteSignature: vi.fn(),
}));

vi.mock("../composer/api", () => ({ fetchSignatures, createSignature, updateSignature, deleteSignature }));

const signature: Signature = { id: "sig1", name: "Default", contentHtml: "<p>Best</p>", isDefault: true };
const secondSignature: Signature = { id: "sig2", name: "Alt", contentHtml: "<p>Regards</p>", isDefault: false };

function renderSettings(signatures: Signature[] = [signature]) {
  fetchSignatures.mockResolvedValue(signatures);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SignatureSettings />
    </QueryClientProvider>,
  );
  return client;
}

describe("SignatureSettings", () => {
  describe("edit-first view (#132): zero or one signature", () => {
    it("shows an open, empty editor when there are no signatures yet, not a list", async () => {
      renderSettings([]);

      const nameInput = await screen.findByLabelText(i18n.t("settings.name"));
      expect(nameInput).toHaveValue("");
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      // Nothing exists yet, so there is no "additional" signature to create
      // and nothing to delete.
      expect(screen.queryByRole("button", { name: i18n.t("settings.newSignature") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("settings.delete") })).not.toBeInTheDocument();
    });

    it("shows the default signature's editor open when there is exactly one signature, not a list", async () => {
      renderSettings([signature]);

      const nameInput = await screen.findByLabelText(i18n.t("settings.name"));
      expect(nameInput).toHaveValue("Default");
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("settings.edit") })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("settings.newSignature") })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("settings.delete") })).toBeInTheDocument();
    });

    it("lets the user reach creating an additional signature from the edit-first view", async () => {
      renderSettings([signature]);

      await screen.findByLabelText(i18n.t("settings.name"));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.newSignature") }));

      const nameInput = screen.getByLabelText(i18n.t("settings.name"));
      expect(nameInput).toHaveValue("");
    });

    it("saving a second signature from the edit-first view transitions to the list", async () => {
      createSignature.mockResolvedValueOnce({ ...secondSignature });
      renderSettings([signature]);

      await screen.findByLabelText(i18n.t("settings.name"));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.newSignature") }));

      fireEvent.change(screen.getByLabelText(i18n.t("settings.name")), { target: { value: "Alt" } });
      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      fireEvent.input(body, { target: { innerHTML: "<p>Regards</p>" } });

      fetchSignatures.mockResolvedValue([signature, secondSignature]);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

      await waitFor(() => expect(createSignature).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("Alt")).toBeInTheDocument();
      expect(screen.getByText("Default")).toBeInTheDocument();
      expect(screen.queryByLabelText(i18n.t("settings.name"))).not.toBeInTheDocument();
    });

    it("edits and saves the sole signature from the edit-first view", async () => {
      updateSignature.mockResolvedValueOnce({ ...signature, name: "Renamed" });
      renderSettings([signature]);

      const nameInput = await screen.findByLabelText(i18n.t("settings.name"));
      fireEvent.change(nameInput, { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

      await waitFor(() =>
        expect(updateSignature).toHaveBeenCalledWith("sig1", expect.objectContaining({ name: "Renamed" })),
      );
    });

    it("deletes the sole signature from the edit-first view, leaving an empty editor open", async () => {
      deleteSignature.mockResolvedValueOnce(undefined);
      renderSettings([signature]);

      await screen.findByLabelText(i18n.t("settings.name"));
      fetchSignatures.mockResolvedValue([]);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.delete") }));

      await waitFor(() => expect(deleteSignature).toHaveBeenCalledWith("sig1"));
      await waitFor(() => expect(screen.getByLabelText(i18n.t("settings.name"))).toHaveValue(""));
    });

    it("toggling the default checkbox and saving still works from the edit-first view", async () => {
      updateSignature.mockResolvedValueOnce({ ...signature, isDefault: false });
      renderSettings([signature]);

      await screen.findByLabelText(i18n.t("settings.name"));
      const checkbox = screen.getByLabelText(i18n.t("settings.default")) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));
      await waitFor(() =>
        expect(updateSignature).toHaveBeenCalledWith("sig1", expect.objectContaining({ isDefault: false })),
      );
    });
  });

  describe("list view (#132): two or more signatures", () => {
    it("shows the list, not an open editor, when there are two or more signatures", async () => {
      renderSettings([signature, secondSignature]);

      expect(await screen.findByText("Default")).toBeInTheDocument();
      expect(screen.getByText("Alt")).toBeInTheDocument();
      expect(screen.queryByLabelText(i18n.t("settings.name"))).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: i18n.t("settings.edit") })).toHaveLength(2);
    });

    it("creates a new signature via the list's New signature button", async () => {
      createSignature.mockResolvedValueOnce({
        id: "sig3",
        name: "New",
        contentHtml: "<p>Hi</p>",
        isDefault: false,
      });
      renderSettings([signature, secondSignature]);

      await screen.findByText("Default");
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.newSignature") }));

      const nameInput = screen.getByLabelText(i18n.t("settings.name"));
      fireEvent.change(nameInput, { target: { value: "New" } });
      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      fireEvent.input(body, { target: { innerHTML: "<p>Hi</p>" } });
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

      await waitFor(() => expect(createSignature).toHaveBeenCalled());
      expect(createSignature).toHaveBeenLastCalledWith(expect.objectContaining({ name: "New" }));
    });

    it("edits a signature from the list", async () => {
      updateSignature.mockResolvedValueOnce({ ...secondSignature, name: "Alt Renamed" });
      renderSettings([signature, secondSignature]);

      await screen.findByText("Alt");
      fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.edit") })[1]!);

      const nameInput = screen.getByLabelText(i18n.t("settings.name"));
      expect(nameInput).toHaveValue("Alt");
      fireEvent.change(nameInput, { target: { value: "Alt Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

      await waitFor(() =>
        expect(updateSignature).toHaveBeenCalledWith("sig2", expect.objectContaining({ name: "Alt Renamed" })),
      );
    });

    it("deletes a signature from the list via its row delete button", async () => {
      deleteSignature.mockResolvedValueOnce(undefined);
      renderSettings([signature, secondSignature]);

      await screen.findByText("Alt");
      fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.delete") })[1]!);

      await waitFor(() => expect(deleteSignature).toHaveBeenCalledWith("sig2"));
    });

    it("falls back to the edit-first view, open on the remaining signature, after a delete drops the count to one", async () => {
      deleteSignature.mockResolvedValueOnce(undefined);
      renderSettings([signature, secondSignature]);

      await screen.findByText("Alt");
      fetchSignatures.mockResolvedValue([signature]);
      fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.delete") })[1]!);

      await waitFor(() => expect(deleteSignature).toHaveBeenCalledWith("sig2"));
      await waitFor(() => expect(screen.getByLabelText(i18n.t("settings.name"))).toHaveValue("Default"));
      expect(screen.queryByText("Alt")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("settings.edit") })).not.toBeInTheDocument();
    });

    it("sets a different signature as default from the list", async () => {
      updateSignature.mockResolvedValueOnce({ ...secondSignature, isDefault: true });
      renderSettings([signature, secondSignature]);

      await screen.findByText("Alt");
      fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.edit") })[1]!);

      const checkbox = screen.getByLabelText(i18n.t("settings.default")) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

      await waitFor(() =>
        expect(updateSignature).toHaveBeenCalledWith("sig2", expect.objectContaining({ isDefault: true })),
      );
    });
  });

  // GH #250: the panel used to `return null` whenever the query had no data,
  // which rendered a failed load as an empty white panel — the same thing a
  // user sees while it is still loading, and nothing to act on either way.
  describe("failed load (GH #250)", () => {
    it("says the load failed instead of rendering a blank panel", async () => {
      fetchSignatures.mockRejectedValue(new MailApiError(503, "database_unavailable"));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <SignatureSettings />
        </QueryClientProvider>,
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.errors.generic"));
      // The blank editor is the EMPTY state, so it must not be what a failure
      // shows — that is exactly the confusion this issue is about.
      expect(screen.queryByLabelText(i18n.t("settings.name"))).not.toBeInTheDocument();
    });

    it("recovers through the retry button without a page reload", async () => {
      fetchSignatures.mockRejectedValueOnce(new MailApiError(503, "database_unavailable"));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <SignatureSettings />
        </QueryClientProvider>,
      );

      await screen.findByRole("alert");
      fetchSignatures.mockResolvedValue([signature]);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.retry") }));

      expect(await screen.findByLabelText(i18n.t("settings.name"))).toHaveValue("Default");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows the loading state, not the empty editor, before the first response", async () => {
      fetchSignatures.mockReturnValue(new Promise(() => {}));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <SignatureSettings />
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId("settings-loading")).toBeInTheDocument();
      expect(screen.queryByLabelText(i18n.t("settings.name"))).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("applies the unified field-focus class to the name input", async () => {
    renderSettings([signature]);

    const nameInput = await screen.findByLabelText(i18n.t("settings.name"));
    expect(nameInput).toHaveClass("field-focus");
  });
});
