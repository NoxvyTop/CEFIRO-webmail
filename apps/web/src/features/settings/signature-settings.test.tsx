import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { Signature } from "@webmail/shared";
import { SignatureSettings } from "./SignatureSettings";

const { fetchSignatures, createSignature, updateSignature, deleteSignature } = vi.hoisted(() => ({
  fetchSignatures: vi.fn(),
  createSignature: vi.fn(),
  updateSignature: vi.fn(),
  deleteSignature: vi.fn(),
}));

vi.mock("../composer/api", () => ({ fetchSignatures, createSignature, updateSignature, deleteSignature }));

const signature: Signature = { id: "sig1", name: "Default", contentHtml: "<p>Best</p>", isDefault: true };

function renderSettings() {
  fetchSignatures.mockResolvedValue([signature]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SignatureSettings />
    </QueryClientProvider>,
  );
}

describe("SignatureSettings", () => {
  it("lists signatures with a default badge, edit and delete buttons", async () => {
    renderSettings();

    expect(await screen.findByText("Default")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings.default"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("settings.edit") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("settings.delete") })).toBeInTheDocument();
  });

  it("submits the create form and calls createSignature with the input", async () => {
    createSignature.mockResolvedValueOnce({
      id: "sig2",
      name: "New",
      contentHtml: "<p>Hi</p>",
      isDefault: false,
    });
    renderSettings();

    await screen.findByText("Default");

    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.newSignature") }));

    const nameInput = screen.getByLabelText(i18n.t("settings.name"));
    fireEvent.change(nameInput, { target: { value: "New" } });

    const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
    fireEvent.input(body, { target: { innerHTML: "<p>Hi</p>" } });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    await waitFor(() => expect(createSignature).toHaveBeenCalledTimes(1));
    expect(createSignature.mock.calls[0]?.[0]).toMatchObject({ name: "New" });
  });

  it("applies the unified field-focus class to the name input", async () => {
    renderSettings();

    await screen.findByText("Default");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.newSignature") }));

    const nameInput = screen.getByLabelText(i18n.t("settings.name"));

    expect(nameInput).toHaveClass("field-focus");
  });

  it("deletes a signature via the delete button", async () => {
    deleteSignature.mockResolvedValueOnce(undefined);
    renderSettings();

    await screen.findByText("Default");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.delete") }));

    await waitFor(() => expect(deleteSignature).toHaveBeenCalledWith("sig1"));
  });
});
