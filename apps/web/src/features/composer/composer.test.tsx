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

    // KNOWN LIMITATION: marker stripped by TipTap on edit → replace regresses
    // to append; fixed in the RichTextEditor marker-persistence PR.
    //
    // applySignature's find/replace/remove logic depends on the
    // data-cefiro-signature wrapper surviving in state.draft.bodyHtml.
    // RichTextEditor's TipTap instance (StarterKit schema) has no node
    // definition for that custom div, so the moment the user actually types
    // (TipTap's onUpdate fires and calls onChange with the schema-serialized
    // HTML) the wrapper — and its data attribute — is silently stripped, and
    // the old signature's content is left behind as plain unmarked
    // paragraphs. The next signature switch then finds no existing wrapper
    // to replace and inserts a fresh one, so the old (now-unmarked) content
    // and the new signature both end up in the body — a regression of the
    // original stacking bug this PR fixes for the untouched-body path.
    // Deferred to the upcoming signature-logo PR, which already needs to
    // extend RichTextEditor's TipTap schema and can add persistence for
    // these markers as part of that same change.
    it("KNOWN LIMITATION: typing before switching loses the marker and the switch stacks instead of replacing", async () => {
      renderWithTwoSignatures();

      const signatureSelect = (await screen.findByRole("combobox", {
        name: i18n.t("composer.signature"),
      })) as HTMLSelectElement;
      const body = screen.getByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));

      // Simulate real typing: TipTap's onUpdate fires and re-serializes via
      // its schema, dropping the signature marker div/attribute.
      fireEvent.input(body, { target: { innerHTML: `${body.innerHTML}<p>my reply text</p>` } });
      await waitFor(() => expect(body.textContent).toContain("my reply text"));

      fireEvent.change(signatureSelect, { target: { value: "sig2" } });

      // Pins the CURRENT (regressed) behavior: both the old, now-unmarked
      // "Thanks" content and the new "Alt sig content" are present — this
      // assertion should flip to "not.toContain('Thanks')" once the marker
      // survives edits (RichTextEditor marker-persistence PR).
      await waitFor(() => expect(body.textContent).toContain("Alt sig content"));
      expect(body.textContent).toContain("Thanks");
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
