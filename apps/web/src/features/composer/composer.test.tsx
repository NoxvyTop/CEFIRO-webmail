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
    uploadAttachment.mockReset();
  });

  it("renders a dialog with identities in the From select", async () => {
    renderComposer();

    expect(await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") })).toBeInTheDocument();

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

  it("gives the underline subject field the line focus treatment, not the boxed ring", async () => {
    renderComposer();

    const subjectInput = await screen.findByRole("textbox", { name: i18n.t("composer.subject") });

    // The composer uses Gmail-style underline fields: focus turns the bottom
    // border accent (focus:border-accent) with the hard outline suppressed
    // (field-focus-line) — never the boxed ring reserved for card inputs.
    expect(subjectInput).toHaveClass("field-focus-line");
    expect(subjectInput).toHaveClass("focus:border-accent");
    expect(subjectInput).not.toHaveClass("field-focus");
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

  describe("attachment cards (#114)", () => {
    it("renders an uploaded attachment as an AttachmentCard (reused preview) with a working remove button", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "b1", type: "image/png", size: 5 });
      renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file = new File(["hello"], "photo.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });
      await act(async () => {
        await Promise.resolve();
      });

      expect(await screen.findAllByTestId("attachment-card-thumbnail")).toHaveLength(1);

      const removeButton = screen.getByRole("button", {
        name: i18n.t("attachments.remove", { name: "photo.png" }),
      });
      fireEvent.click(removeButton);

      await waitFor(() =>
        expect(screen.queryAllByTestId("attachment-card-thumbnail")).toHaveLength(0),
      );
    });

    it("renders a pending upload as a lightweight placeholder (no blobId to preview yet)", async () => {
      uploadAttachment.mockReturnValueOnce(new Promise(() => {})); // never resolves — stays pending
      renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file = new File(["hello"], "uploading.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      expect(await screen.findByText(/uploading\.png/)).toBeInTheDocument();
      // Pending uploads have no blobId yet, so they must not render the
      // full preview-capable AttachmentCard structure.
      expect(screen.queryByTestId("attachment-card-thumbnail")).not.toBeInTheDocument();
    });
  });

  describe("duplicate attachment dedup (#114)", () => {
    it("skips a file that duplicates one already attached (same name+size) and shows a notice", async () => {
      // The mocked upload response's size must match the real File's byte
      // size ("hola" = 4 bytes) — dedup compares the incoming File's actual
      // size against the previously-reported attachment size, exactly as a
      // real server (which echoes back the size it received) would.
      uploadAttachment.mockResolvedValueOnce({ blobId: "b1", type: "text/plain", size: 4 });
      renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file1 = new File(["hola"], "note.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [file1] } });
      // Wait for the upload to actually resolve into a real attachment
      // (not just for the call count, which is already true synchronously)
      // — the dedup check on the next addFiles call reads state.attachments,
      // so it must have committed before firing the duplicate.
      expect(await screen.findByTestId("attachment-card-thumbnail")).toBeInTheDocument();

      const file2 = new File(["hola"], "note.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [file2] } });

      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole("status")).toHaveTextContent(
        i18n.t("composer.duplicateAttachment", { name: "note.txt" }),
      );
    });
  });

  describe("drag and drop attaching (#112)", () => {
    it("shows the drop hint while dragging files over the composer dialog", async () => {
      renderComposer();
      const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      fireEvent.dragOver(dialog, { dataTransfer: { types: ["Files"], files: [] } });

      expect(await screen.findByText(i18n.t("composer.dropHint"))).toBeInTheDocument();
    });

    it("attaches dropped files via addFiles", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "b2", type: "image/png", size: 9 });
      renderComposer();
      const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      const file = new File(["hi"], "dropped.png", { type: "image/png" });

      fireEvent.drop(dialog, { dataTransfer: { types: ["Files"], files: [file] } });

      await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/dropped\.png/)).toBeInTheDocument();
    });

    it("hides the drop hint again after the drop completes", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "b3", type: "image/png", size: 9 });
      renderComposer();
      const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      const file = new File(["hi"], "dropped2.png", { type: "image/png" });

      fireEvent.dragOver(dialog, { dataTransfer: { types: ["Files"], files: [] } });
      expect(await screen.findByText(i18n.t("composer.dropHint"))).toBeInTheDocument();

      fireEvent.drop(dialog, { dataTransfer: { types: ["Files"], files: [file] } });

      await waitFor(() =>
        expect(screen.queryByText(i18n.t("composer.dropHint"))).not.toBeInTheDocument(),
      );
    });

    it("ignores a non-file drag (dataTransfer.types without Files) — no hint, no preventDefault hijack", async () => {
      renderComposer();
      const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      fireEvent.dragOver(dialog, { dataTransfer: { types: ["text/plain"], files: [] } });

      expect(screen.queryByText(i18n.t("composer.dropHint"))).not.toBeInTheDocument();
    });
  });

  describe("default signature auto-apply and switching", () => {
    const altSignature: Signature = {
      id: "sig2",
      name: "Alt",
      contentHtml: "<p>Alt sig content</p>",
      isDefault: false,
    };

    function renderWithTwoSignatures(onClose = vi.fn(), initial: ComposerDraft = baseDraft()) {
      fetchIdentities.mockResolvedValue(identities);
      fetchSignatures.mockResolvedValue([signatures[0], altSignature]);
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

    it("auto-applies the default signature on open and pre-selects it in the select", async () => {
      renderWithTwoSignatures();

      const signatureSelect = (await screen.findByRole("combobox", {
        name: i18n.t("composer.signature"),
      })) as HTMLSelectElement;
      await waitFor(() => expect(signatureSelect.value).toBe("sig1"));

      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));
    });

    it("does not auto-apply anything when no signature is marked default", async () => {
      fetchIdentities.mockResolvedValue(identities);
      fetchSignatures.mockResolvedValue([altSignature]);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            <Composer initial={baseDraft()} onClose={vi.fn()} />
          </ToastProvider>
        </QueryClientProvider>,
      );

      const signatureSelect = (await screen.findByRole("combobox", {
        name: i18n.t("composer.signature"),
      })) as HTMLSelectElement;
      await waitFor(() => expect(signatureSelect.querySelectorAll("option")).toHaveLength(2));
      expect(signatureSelect.value).toBe("");

      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      expect(body.textContent).not.toContain("Alt sig content");
    });

    it("replaces the applied signature instead of stacking a second one when switching", async () => {
      renderWithTwoSignatures();

      const signatureSelect = (await screen.findByRole("combobox", {
        name: i18n.t("composer.signature"),
      })) as HTMLSelectElement;
      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));

      fireEvent.change(signatureSelect, { target: { value: "sig2" } });

      await waitFor(() => expect(body.textContent).toContain("Alt sig content"));
      expect(body.textContent).not.toContain("Thanks");

      // Switching back doesn't stack a second copy of the default either.
      fireEvent.change(signatureSelect, { target: { value: "sig1" } });

      await waitFor(() => expect(body.textContent).toContain("Thanks"));
      expect(body.textContent).not.toContain("Alt sig content");
    });

    it("removes the signature entirely when selecting the empty option", async () => {
      renderWithTwoSignatures();

      const signatureSelect = (await screen.findByRole("combobox", {
        name: i18n.t("composer.signature"),
      })) as HTMLSelectElement;
      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));

      fireEvent.change(signatureSelect, { target: { value: "" } });

      await waitFor(() => expect(body.textContent).not.toContain("Thanks"));
    });

    // applySignature's find/replace/remove logic depends on the
    // data-cefiro-signature wrapper surviving in state.draft.bodyHtml.
    // RichTextEditor's TipTap instance now includes MarkerBlock
    // (markerBlockExtension.ts), which gives that custom div — and
    // data-cefiro-quote — a real schema node, so the wrapper (and its data
    // attribute) survives onUpdate's schema-serialized HTML even after the
    // user types. That keeps applySignature's find/replace working correctly
    // in the type-then-switch flow instead of regressing to append.
    it("replaces (not stacks) the applied signature after typing, then switching", async () => {
      renderWithTwoSignatures();

      const signatureSelect = (await screen.findByRole("combobox", {
        name: i18n.t("composer.signature"),
      })) as HTMLSelectElement;
      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));

      // Simulate real typing: TipTap's onUpdate fires and re-serializes via
      // its schema. With MarkerBlock registered, the signature marker div
      // survives this round trip.
      fireEvent.input(body, { target: { innerHTML: `${body.innerHTML}<p>my reply text</p>` } });
      await waitFor(() => expect(body.textContent).toContain("my reply text"));

      fireEvent.change(signatureSelect, { target: { value: "sig2" } });

      // The old signature content is fully replaced — no stacking.
      await waitFor(() => expect(body.textContent).toContain("Alt sig content"));
      expect(body.textContent).not.toContain("Thanks");
      // The typed content in between is untouched.
      expect(body.textContent).toContain("my reply text");
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
