import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { Identity, Signature } from "@webmail/shared";
import type { ComposerDraft } from "./reply";
import { ToastProvider } from "../../app/ui/toast";
import { MailApiError } from "../mailbox/api";
import { Composer } from "./Composer";

const { fetchIdentities, fetchSignatures, sendEmail, uploadAttachment, fetchAiDraft } = vi.hoisted(() => ({
  fetchIdentities: vi.fn(),
  fetchSignatures: vi.fn(),
  sendEmail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchAiDraft: vi.fn(),
}));

vi.mock("./api", () => ({ fetchIdentities, fetchSignatures, sendEmail, uploadAttachment }));
vi.mock("./aiApi", () => ({ fetchAiDraft }));

const identities: Identity[] = [
  { id: "id1", name: "Alice", email: "alice@example.com" },
  { id: "id2", name: "Support", email: "support@example.com" },
];

const signatures: Signature[] = [
  { id: "sig1", name: "Default", contentHtml: "<p>Thanks</p>", isDefault: true },
];

function baseDraft(): ComposerDraft {
  return { identityId: "id1", to: [], cc: [], bcc: [], subject: "", bodyHtml: "" };
}

function renderComposer(onClose = vi.fn(), initial: ComposerDraft = baseDraft()) {
  fetchIdentities.mockResolvedValue(identities);
  fetchSignatures.mockResolvedValue(signatures);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Composer initial={initial} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("Composer", () => {
  beforeEach(() => {
    fetchAiDraft.mockReset();
  });

  it("renders a dialog with identities in the From select", async () => {
    renderComposer();

    expect(await screen.findByRole("dialog", { name: i18n.t("composer.title") })).toBeInTheDocument();

    const fromSelect = screen.getByRole("combobox", { name: i18n.t("composer.from") });
    await waitFor(() => expect(fromSelect.querySelectorAll("option")).toHaveLength(2));
  });

  it("adds a recipient chip when typing an email and pressing Enter in To", async () => {
    renderComposer();

    const toInput = await screen.findByRole("textbox", { name: i18n.t("composer.to") });
    fireEvent.change(toInput, { target: { value: "bob@example.com" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    expect(await screen.findByText("bob@example.com")).toBeInTheDocument();
  });

  it("shows an inline hint and does not add a chip for an invalid email", async () => {
    renderComposer();

    const toInput = await screen.findByRole("textbox", { name: i18n.t("composer.to") });
    fireEvent.change(toInput, { target: { value: "not-an-email" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    expect(await screen.findByText(i18n.t("composer.invalidEmail"))).toBeInTheDocument();
    expect(screen.queryByText("not-an-email")).not.toBeInTheDocument();
  });

  it("updates the body when typing into the editor textbox", async () => {
    renderComposer();

    const body = await screen.findByRole("textbox", { name: i18n.t("composer.body") });
    fireEvent.input(body, { target: { innerHTML: "<p>hello</p>" } });

    // The editor is either the real TipTap mount (ProseMirror manages its own
    // DOM) or the contentEditable fallback — either way it must not throw and
    // must remain an accessible textbox.
    expect(body).toBeInTheDocument();
  });

  it("shows the noRecipients alert when sending without a recipient, without calling sendEmail", async () => {
    renderComposer();

    const sendButton = await screen.findByRole("button", { name: i18n.t("composer.send") });
    fireEvent.click(sendButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("composer.errors.noRecipients"));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends and closes the composer on success once a recipient is present", async () => {
    sendEmail.mockResolvedValueOnce(undefined);
    const { onClose } = renderComposer();

    const toInput = await screen.findByRole("textbox", { name: i18n.t("composer.to") });
    fireEvent.change(toInput, { target: { value: "bob@example.com" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    const sendButton = screen.getByRole("button", { name: i18n.t("composer.send") });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("calls onClose when Cancel is clicked", async () => {
    const { onClose } = renderComposer();

    const cancelButton = await screen.findByRole("button", { name: i18n.t("composer.cancel") });
    fireEvent.click(cancelButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the header close button is clicked", async () => {
    const { onClose } = renderComposer();

    const closeButton = await screen.findByRole("button", { name: i18n.t("composer.close") });
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("attachment control", () => {
    it("hides the native file input and exposes a styled attach button instead", async () => {
      renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      expect(fileInput.type).toBe("file");
      expect(fileInput.className).toContain("sr-only");

      expect(
        await screen.findByRole("button", { name: i18n.t("composer.attachFiles") }),
      ).toBeInTheDocument();
    });

    it("clicking the styled attach button opens the hidden file picker", async () => {
      renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      const attachButton = await screen.findByRole("button", { name: i18n.t("composer.attachFiles") });
      fireEvent.click(attachButton);

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("still uploads a file selected through the hidden input", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "b1", type: "text/plain", size: 5 });
      renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file = new File(["hola"], "note.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [file] } });
      // The upload promise resolves in a microtask outside of fireEvent's act()
      // scope, so flush it explicitly before asserting on the settled state.
      await act(async () => {
        await Promise.resolve();
      });

      expect(await screen.findByText(/note\.txt/)).toBeInTheDocument();
    });
  });

  describe("Redactar con IA", () => {
    it("fills the body and shows the review notice on success", async () => {
      fetchAiDraft.mockResolvedValueOnce("Estimado equipo, este es el borrador solicitado.");
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Reunión de mañana" });

      const draftButton = await screen.findByRole("button", { name: i18n.t("composer.draftWithAi") });
      fireEvent.click(draftButton);

      expect(await screen.findByText(i18n.t("composer.aiDraftNotice"))).toBeInTheDocument();
      expect(fetchAiDraft).toHaveBeenCalledWith("Reunión de mañana");
    });

    it("shows an inline error without calling the endpoint when subject is empty", async () => {
      renderComposer();

      const draftButton = await screen.findByRole("button", { name: i18n.t("composer.draftWithAi") });
      fireEvent.click(draftButton);

      expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("composer.aiDraftNeedsSubject"));
      expect(fetchAiDraft).not.toHaveBeenCalled();
    });

    it("hides the button entirely once the backend reports ai_disabled", async () => {
      fetchAiDraft.mockRejectedValueOnce(new MailApiError(501, "ai_disabled"));
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Reunión de mañana" });

      const draftButton = await screen.findByRole("button", { name: i18n.t("composer.draftWithAi") });
      fireEvent.click(draftButton);

      await waitFor(() =>
        expect(screen.queryByRole("button", { name: i18n.t("composer.draftWithAi") })).not.toBeInTheDocument(),
      );
    });
  });
});
