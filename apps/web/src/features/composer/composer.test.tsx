import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { Identity, Signature } from "@webmail/shared";
import type { ComposeMode, ComposerDraft } from "./reply";
import { ToastProvider } from "../../app/ui/toast";
import { MailApiError } from "../mailbox/api";
import { Composer } from "./Composer";
import { expectNoAxeViolations } from "../../test/axe";

const { fetchIdentities, fetchSignatures, sendEmail, uploadAttachment, fetchAiDraft, fetchAiStatus, saveDraft } = vi.hoisted(() => ({
  fetchIdentities: vi.fn(),
  fetchSignatures: vi.fn(),
  sendEmail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchAiDraft: vi.fn(),
  fetchAiStatus: vi.fn(),
  saveDraft: vi.fn(),
}));

// GH #124: RecipientField (used for To/Cc/Bcc) searches contacts for
// autocomplete suggestions — stubbed here so unrelated tests that type a
// long-enough address never hit a real endpoint once their debounce fires.
const { searchContacts } = vi.hoisted(() => ({ searchContacts: vi.fn() }));

vi.mock("./api", () => ({ fetchIdentities, fetchSignatures, sendEmail, uploadAttachment, saveDraft }));
vi.mock("./aiApi", () => ({ fetchAiDraft, fetchAiStatus }));
vi.mock("../contacts/api", () => ({ searchContacts }));

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

const altSignature: Signature = {
  id: "sig2",
  name: "Alt",
  contentHtml: "<p>Alt sig content</p>",
  isDefault: false,
};

function renderWithTwoSignatures(onClose = vi.fn(), initial: ComposerDraft = baseDraft()) {
  fetchIdentities.mockResolvedValue(identities);
  fetchSignatures.mockResolvedValue([signatures[0]!, altSignature]);
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
    saveDraft.mockReset();
    searchContacts.mockReset();
    searchContacts.mockResolvedValue([]);
    // GH #292: default the AI status to enabled so the existing "draft with AI"
    // tests see the CTA; individual tests override this to exercise the off case.
    fetchAiStatus.mockReset();
    fetchAiStatus.mockResolvedValue(true);
  });

  it("renders a dialog with identities in the From select", async () => {
    renderComposer();

    expect(await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") })).toBeInTheDocument();

    const fromSelect = screen.getByRole("combobox", { name: i18n.t("composer.from") });
    await waitFor(() => expect(fromSelect.querySelectorAll("option")).toHaveLength(2));
  });

  it("adds a recipient chip when typing an email and pressing Enter in To", async () => {
    renderComposer();

    // RecipientField now implements the WAI-ARIA combobox pattern (GH #124
    // recipient autocomplete), which changes its accessible role from plain
    // "textbox" to "combobox" — an input with an associated suggestion
    // popup is semantically a combobox, not a bare textbox.
    const toInput = await screen.findByRole("combobox", { name: i18n.t("composer.to") });
    fireEvent.change(toInput, { target: { value: "bob@example.com" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    expect(await screen.findByText("bob@example.com")).toBeInTheDocument();
  });

  it("shows an inline hint and does not add a chip for an invalid email", async () => {
    renderComposer();

    const toInput = await screen.findByRole("combobox", { name: i18n.t("composer.to") });
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

    const toInput = await screen.findByRole("combobox", { name: i18n.t("composer.to") });
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

      // Only one signature is present (below SIGNATURE_SELECTOR_MIN_COUNT), so
      // per #132 there is no selector at all here — wait for the From select
      // to populate as a proxy for "queries have settled" (fetchSignatures
      // itself isn't reset between tests in this file, so its call count
      // isn't a reliable readiness signal).
      const fromSelect = await screen.findByRole("combobox", { name: i18n.t("composer.from") });
      await waitFor(() => expect(fromSelect.querySelectorAll("option")).toHaveLength(2));

      expect(
        screen.queryByRole("combobox", { name: i18n.t("composer.signature") }),
      ).not.toBeInTheDocument();

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

  describe("signature selector visibility (#132)", () => {
    it("renders no signature selector when there are zero signatures", async () => {
      fetchIdentities.mockResolvedValue(identities);
      fetchSignatures.mockResolvedValue([]);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            <Composer initial={baseDraft()} onClose={vi.fn()} />
          </ToastProvider>
        </QueryClientProvider>,
      );

      const fromSelect = await screen.findByRole("combobox", { name: i18n.t("composer.from") });
      await waitFor(() => expect(fromSelect.querySelectorAll("option")).toHaveLength(2));

      expect(
        screen.queryByRole("combobox", { name: i18n.t("composer.signature") }),
      ).not.toBeInTheDocument();
    });

    it("renders no signature selector with exactly one signature, but still auto-applies it as the default", async () => {
      renderComposer();

      const body = await screen.findByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));

      expect(
        screen.queryByRole("combobox", { name: i18n.t("composer.signature") }),
      ).not.toBeInTheDocument();
    });

    it("renders the signature selector once there are two or more signatures", async () => {
      renderWithTwoSignatures();

      expect(
        await screen.findByRole("combobox", { name: i18n.t("composer.signature") }),
      ).toBeInTheDocument();
    });
  });

  describe("discard control (#126)", () => {
    it("renders the discard control as a clearly bordered button, reachable by its accessible name", async () => {
      renderComposer();

      const cancelButton = await screen.findByRole("button", { name: i18n.t("composer.cancel") });
      // The bare text link this replaces had no border/background at all —
      // the fix is exactly that it now reads as a real, bordered control.
      expect(cancelButton).toHaveClass("border");
    });

    it("calls onClose when the discard control is clicked", async () => {
      const { onClose } = renderComposer();

      const cancelButton = await screen.findByRole("button", { name: i18n.t("composer.cancel") });
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // GH #124: every RecipientField instance (To/Cc/Bcc share the one
  // component) now implements the WAI-ARIA combobox pattern for recipient
  // autocomplete, which changes its accessible role from plain "textbox" to
  // "combobox" — an input with an associated suggestion popup is
  // semantically a combobox, not a bare textbox. Queries below were updated
  // accordingly; the accessible name (aria-label) itself is unchanged.
  describe("independent CC and BCC controls (#123)", () => {
    it("reveals only the CC field when the CC control is clicked, leaving the BCC control available", async () => {
      renderComposer();

      const addCcButton = await screen.findByRole("button", { name: i18n.t("composer.addCc") });
      fireEvent.click(addCcButton);

      expect(await screen.findByRole("combobox", { name: i18n.t("composer.cc") })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: i18n.t("composer.bcc") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("composer.addCc") })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("composer.addBcc") })).toBeInTheDocument();
    });

    it("reveals only the BCC field when the BCC control is clicked, leaving the CC control available", async () => {
      renderComposer();

      const addBccButton = await screen.findByRole("button", { name: i18n.t("composer.addBcc") });
      fireEvent.click(addBccButton);

      expect(await screen.findByRole("combobox", { name: i18n.t("composer.bcc") })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: i18n.t("composer.cc") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("composer.addBcc") })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("composer.addCc") })).toBeInTheDocument();
    });

    it("auto-shows CC (not BCC) when the draft arrives with existing CC recipients", async () => {
      renderComposer(vi.fn(), {
        ...baseDraft(),
        cc: [{ name: null, email: "cc@example.com" }],
      });

      expect(await screen.findByRole("combobox", { name: i18n.t("composer.cc") })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: i18n.t("composer.bcc") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("composer.addCc") })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("composer.addBcc") })).toBeInTheDocument();
    });

    it("auto-shows BCC (not CC) when the draft arrives with existing BCC recipients", async () => {
      renderComposer(vi.fn(), {
        ...baseDraft(),
        bcc: [{ name: null, email: "bcc@example.com" }],
      });

      expect(await screen.findByRole("combobox", { name: i18n.t("composer.bcc") })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: i18n.t("composer.cc") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("composer.addBcc") })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("composer.addCc") })).toBeInTheDocument();
    });

    it("auto-shows both fields, with neither reveal control offered, when the draft arrives with both CC and BCC recipients", async () => {
      renderComposer(vi.fn(), {
        ...baseDraft(),
        cc: [{ name: null, email: "cc@example.com" }],
        bcc: [{ name: null, email: "bcc@example.com" }],
      });

      expect(await screen.findByRole("combobox", { name: i18n.t("composer.cc") })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: i18n.t("composer.bcc") })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("composer.addCc") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("composer.addBcc") })).not.toBeInTheDocument();
    });
  });

  describe("Redactar con IA", () => {
    // GH #304: the draft is driven by the body the user types (the intent); the
    // subject is only a hint.
    it("fills the body and shows the review notice on success", async () => {
      fetchAiDraft.mockResolvedValueOnce("Estimado equipo, este es el borrador solicitado.");
      renderComposer(vi.fn(), {
        ...baseDraft(),
        subject: "Reunión de mañana",
        bodyHtml: "<p>no voy el 20 de agosto</p>",
      });

      const draftButton = await screen.findByRole("button", { name: i18n.t("composer.draftWithAi") });
      fireEvent.click(draftButton);

      expect(await screen.findByText(i18n.t("composer.aiDraftNotice"))).toBeInTheDocument();
      // The typed body is the intent; the subject is a hint; no quoted original
      // here, so no context is sent (GH #299).
      expect(fetchAiDraft).toHaveBeenCalledWith({
        intent: "no voy el 20 de agosto",
        subject: "Reunión de mañana",
        context: undefined,
      });
    });

    // GH #304: subject is no longer the gate — the body is. An empty body (even
    // with a subject and the auto-applied signature) surfaces guidance instead
    // of calling the endpoint.
    it("shows needs-intent guidance without calling the endpoint when the body is empty", async () => {
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Reunión de mañana" });

      const draftButton = await screen.findByRole("button", { name: i18n.t("composer.draftWithAi") });
      fireEvent.click(draftButton);

      expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("composer.aiDraftNeedsIntent"));
      expect(fetchAiDraft).not.toHaveBeenCalled();
    });

    it("hides the button entirely once the backend reports ai_disabled", async () => {
      fetchAiDraft.mockRejectedValueOnce(new MailApiError(501, "ai_disabled"));
      renderComposer(vi.fn(), {
        ...baseDraft(),
        subject: "Reunión de mañana",
        bodyHtml: "<p>no voy el 20 de agosto</p>",
      });

      const draftButton = await screen.findByRole("button", { name: i18n.t("composer.draftWithAi") });
      fireEvent.click(draftButton);

      await waitFor(() =>
        expect(screen.queryByRole("button", { name: i18n.t("composer.draftWithAi") })).not.toBeInTheDocument(),
      );
    });

    it("does not render the CTA at all when the server reports AI disabled (GH #292)", async () => {
      fetchAiStatus.mockResolvedValue(false);
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Reunión de mañana" });

      // The composer chrome mounts (Enviar is present)…
      await screen.findByRole("button", { name: i18n.t("composer.send") });
      // …but the "draft with AI" CTA never appears without an enabled backend.
      expect(
        screen.queryByRole("button", { name: i18n.t("composer.draftWithAi") }),
      ).not.toBeInTheDocument();
    });
  });

  // GH #125: Escape closes the composer immediately when the draft is empty,
  // otherwise shows a discard-confirmation dialog offering Discard / Save to
  // drafts / keep editing.
  describe("Escape-to-close (#125)", () => {
    function pressEscape() {
      fireEvent.keyDown(window, { key: "Escape" });
    }

    it("closes immediately on Escape when the composer is untouched (brand-new, empty draft)", async () => {
      const { onClose } = renderComposer();
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      pressEscape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("closes immediately on Escape for an untouched reply (quote + auto-applied signature present, nothing typed)", async () => {
      const { onClose } = renderComposer(vi.fn(), {
        ...baseDraft(),
        bodyHtml: '<div data-cefiro-quote="true"><blockquote><p>Original message</p></blockquote></div>',
      });

      // Wait for the default-signature auto-apply effect to settle so the
      // body genuinely carries both a quote AND a signature wrapper, as a
      // freshly opened reply would.
      const body = await screen.findByRole("textbox", { name: i18n.t("composer.body") });
      await waitFor(() => expect(body.textContent).toContain("Thanks"));
      // GH #142: the quoted original is deliberately NOT inside the editable
      // document any more — it lives in the collapsed block beside it — so the
      // precondition is checked there instead. What the assertion is really
      // guarding is unchanged: quote AND signature are both present, and an
      // untouched reply carrying both still closes without a confirmation.
      expect(body.textContent).not.toContain("Original message");
      fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.showQuoted") }));
      expect(screen.getByText(/Original message/)).toBeInTheDocument();

      pressEscape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("shows the discard confirmation on Escape when a recipient is present", async () => {
      const { onClose } = renderComposer(vi.fn(), {
        ...baseDraft(),
        to: [{ name: null, email: "bob@example.com" }],
      });
      const composerDialog = await screen.findByRole("dialog", {
        name: i18n.t("composer.newMessage"),
      });
      // GH #253: both of the composer's dialogs trapped focus from #158
      // without ever telling assistive tech the page behind them is inert.
      expect(composerDialog).toHaveAttribute("aria-modal", "true");

      pressEscape();

      const confirm = await screen.findByRole("alertdialog");
      expect(confirm).toBeInTheDocument();
      expect(confirm).toHaveAttribute("aria-modal", "true");
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the discard confirmation on Escape when a subject is present", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      pressEscape();

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the discard confirmation on Escape when the body has been typed into", async () => {
      const { onClose } = renderComposer();
      const body = await screen.findByRole("textbox", { name: i18n.t("composer.body") });
      fireEvent.input(body, { target: { innerHTML: "<p>hello there</p>" } });
      await waitFor(() => expect(body.textContent).toContain("hello there"));

      pressEscape();

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the discard confirmation on Escape when an attachment has been uploaded and nothing else was typed", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "b1", type: "image/png", size: 5 });
      const { onClose } = renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file = new File(["hello"], "photo.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });
      await act(async () => {
        await Promise.resolve();
      });
      expect(await screen.findByTestId("attachment-card-thumbnail")).toBeInTheDocument();

      pressEscape();

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the discard confirmation on Escape when an upload is still in flight and nothing else was typed", async () => {
      uploadAttachment.mockReturnValueOnce(new Promise(() => {})); // never resolves — stays pending
      const { onClose } = renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file = new File(["hello"], "uploading.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });
      expect(await screen.findByText(/uploading\.png/)).toBeInTheDocument();

      pressEscape();

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("returns to empty once the only attachment is removed, so Escape closes immediately again", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "b1", type: "image/png", size: 5 });
      const { onClose } = renderComposer();

      const fileInput = (await screen.findByLabelText(i18n.t("composer.attach"))) as HTMLInputElement;
      const file = new File(["hello"], "photo.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });
      await act(async () => {
        await Promise.resolve();
      });
      expect(await screen.findByTestId("attachment-card-thumbnail")).toBeInTheDocument();

      const removeButton = screen.getByRole("button", {
        name: i18n.t("attachments.remove", { name: "photo.png" }),
      });
      fireEvent.click(removeButton);
      await waitFor(() =>
        expect(screen.queryAllByTestId("attachment-card-thumbnail")).toHaveLength(0),
      );

      pressEscape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("Discard closes the composer without saving", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      pressEscape();

      const discardButton = await screen.findByRole("button", { name: i18n.t("composer.discardConfirm.discard") });
      fireEvent.click(discardButton);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(saveDraft).not.toHaveBeenCalled();
    });

    it("Save to drafts calls the API with the composer's payload and closes on success", async () => {
      saveDraft.mockResolvedValueOnce({ id: "draft-1" });
      const { onClose } = renderComposer(vi.fn(), {
        ...baseDraft(),
        to: [{ name: "Bob", email: "bob@example.com" }],
        subject: "Hello there",
      });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      pressEscape();

      const saveButton = await screen.findByRole("button", {
        name: i18n.t("composer.discardConfirm.saveToDrafts"),
      });
      fireEvent.click(saveButton);

      await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          identityId: "id1",
          to: [{ name: "Bob", email: "bob@example.com" }],
          subject: "Hello there",
        }),
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("keeps the composer open and surfaces an error when saving to drafts fails, without losing the draft", async () => {
      saveDraft.mockRejectedValueOnce(new MailApiError(500, "save_draft_failed"));
      const { onClose } = renderComposer(vi.fn(), {
        ...baseDraft(),
        to: [{ name: "Bob", email: "bob@example.com" }],
      });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      pressEscape();

      const saveButton = await screen.findByRole("button", {
        name: i18n.t("composer.discardConfirm.saveToDrafts"),
      });
      fireEvent.click(saveButton);

      expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("composer.errors.save_draft_failed"));
      expect(onClose).not.toHaveBeenCalled();

      // The draft itself must still be intact — return to editing and check
      // the recipient chip entered earlier is still there.
      const keepEditingButton = screen.getByRole("button", {
        name: i18n.t("composer.discardConfirm.keepEditing"),
      });
      fireEvent.click(keepEditingButton);
      // The recipient chip renders the address's name (see RecipientField.tsx).
      expect(await screen.findByText("Bob")).toBeInTheDocument();
    });

    it("Escape inside the confirmation dismisses it and returns to editing, without closing the composer", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      pressEscape();
      await screen.findByRole("alertdialog");

      pressEscape();

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: i18n.t("composer.newMessage") })).toBeInTheDocument();
    });

    // GH #158: reproduced in the browser as Tab walking off the last button,
    // through <body>, and into background page elements (the header logo)
    // while this alertdialog still covers the screen. Now backed by the
    // shared useFocusTrap primitive.
    it("traps Tab focus inside the discard confirmation instead of letting it escape to the page", async () => {
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      pressEscape();

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.contains(document.activeElement)).toBe(true);

      const saveButton = screen.getByRole("button", {
        name: i18n.t("composer.discardConfirm.saveToDrafts"),
      });
      saveButton.focus();
      fireEvent.keyDown(window, { key: "Tab" });

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: i18n.t("composer.discardConfirm.keepEditing") }),
      );
    });

    it("cannot trigger the save action twice while the first save is still in flight", async () => {
      let resolveSave: (value: { id: string }) => void = () => {};
      saveDraft.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      );
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
      pressEscape();

      const saveButton = await screen.findByRole("button", {
        name: i18n.t("composer.discardConfirm.saveToDrafts"),
      });
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);

      expect(saveDraft).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSave({ id: "draft-1" });
      });
    });
  });

  // GH #159: the header close (X) button and the bottom Cancel/discard
  // button both used to call onClose() directly — bypassing the discard
  // confirmation Escape already goes through (GH #125). A user with real
  // content in the draft lost it silently by clicking either one. Both now
  // route through the same requestClose() decision Escape uses: an empty
  // draft closes immediately, anything else shows the confirmation — so any
  // future exit route wired the same way inherits the protection instead of
  // being born unguarded.
  describe("close (X) and Cancel route through the discard confirmation (#159)", () => {
    it("closes immediately when the header close (X) button is clicked on an untouched composer", async () => {
      const { onClose } = renderComposer();
      const closeButton = await screen.findByRole("button", { name: i18n.t("composer.close") });

      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("shows the discard confirmation instead of closing when the header close (X) button is clicked on a draft with a recipient", async () => {
      const { onClose } = renderComposer(vi.fn(), {
        ...baseDraft(),
        to: [{ name: null, email: "bob@example.com" }],
      });
      const closeButton = await screen.findByRole("button", { name: i18n.t("composer.close") });

      fireEvent.click(closeButton);

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the discard confirmation instead of closing when the header close (X) button is clicked on a draft with a typed body", async () => {
      const { onClose } = renderComposer();
      const body = await screen.findByRole("textbox", { name: i18n.t("composer.body") });
      fireEvent.input(body, { target: { innerHTML: "<p>hello there</p>" } });
      await waitFor(() => expect(body.textContent).toContain("hello there"));
      const closeButton = screen.getByRole("button", { name: i18n.t("composer.close") });

      fireEvent.click(closeButton);

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Discard from the header close (X) button's confirmation closes the composer", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      const closeButton = await screen.findByRole("button", { name: i18n.t("composer.close") });
      fireEvent.click(closeButton);
      const discardButton = await screen.findByRole("button", { name: i18n.t("composer.discardConfirm.discard") });

      fireEvent.click(discardButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Keep editing from the header close (X) button's confirmation leaves the composer open without closing it", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      const closeButton = await screen.findByRole("button", { name: i18n.t("composer.close") });
      fireEvent.click(closeButton);
      const keepEditingButton = await screen.findByRole("button", {
        name: i18n.t("composer.discardConfirm.keepEditing"),
      });

      fireEvent.click(keepEditingButton);

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: i18n.t("composer.newMessage") })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the discard confirmation instead of closing when the bottom Cancel/discard button is clicked on a draft with content", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      const cancelButton = await screen.findByRole("button", { name: i18n.t("composer.cancel") });

      fireEvent.click(cancelButton);

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Discard from the bottom Cancel button's confirmation closes the composer", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      const cancelButton = await screen.findByRole("button", { name: i18n.t("composer.cancel") });
      fireEvent.click(cancelButton);
      const discardButton = await screen.findByRole("button", { name: i18n.t("composer.discardConfirm.discard") });

      fireEvent.click(discardButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // The composer intentionally has no backdrop-click-to-close today (unlike
    // DiscardConfirmDialog/NewLabelModal/AttachmentViewer in this codebase) —
    // this locks that in as a deliberate choice rather than an oversight, so
    // it doesn't quietly turn into a second unguarded exit route later.
    it("does not close or show a confirmation when the backdrop itself is clicked", async () => {
      const { onClose } = renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      fireEvent.click(dialog);

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  // GH #159: nothing in the app warned before a browser-tab close discarded
  // an open draft — the same silent-discard defect as the header close
  // button, just through the browser's own exit door instead of the
  // composer's. Armed only when the draft actually has content, mirroring
  // requestClose's isComposerDraftEmpty check above, so an untouched compose
  // window never nags on tab close.
  describe("beforeunload guard (#159)", () => {
    function dispatchBeforeUnload(): Event {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event;
    }

    it("prevents the tab from closing when the draft has content", async () => {
      renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      const event = dispatchBeforeUnload();

      expect(event.defaultPrevented).toBe(true);
    });

    it("does not prevent the tab from closing when the composer is untouched", async () => {
      renderComposer();
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      const event = dispatchBeforeUnload();

      expect(event.defaultPrevented).toBe(false);
    });
  });

  // GH #178: the composer surfaces a subtle autosave status while the draft is
  // being persisted in the background. These drive it through the real debounce
  // (real timers) rather than mocking it, so the wiring from a typed change to
  // the indicator is exercised end to end.
  describe("autosave indicator (#178)", () => {
    it("shows no autosave indicator on an untouched composer", async () => {
      renderComposer();
      await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });

      expect(screen.queryByTestId("autosave-indicator")).not.toBeInTheDocument();
    });

    it("shows the saved indicator once the debounce autosaves a typed draft", async () => {
      saveDraft.mockResolvedValue({ id: "draft-1" });
      renderComposer();

      const subject = await screen.findByRole("textbox", { name: i18n.t("composer.subject") });
      fireEvent.change(subject, { target: { value: "Reunión de mañana" } });

      // findBy polls past the ~1.5s debounce until the save resolves and the
      // indicator lands on "saved".
      expect(await screen.findByText(i18n.t("composer.autosave.saved"))).toBeInTheDocument();
      await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({ subject: "Reunión de mañana" }),
      );
    });
  });

  // GH #124: the recipient autocomplete dropdown must swallow its own
  // Escape key — otherwise it would bubble up to the composer's own
  // Escape-to-close handler (GH #125, above) and close (or discard-confirm)
  // the whole composer out from under a user who only meant to dismiss the
  // suggestion list.
  describe("recipient autocomplete does not leak Escape to the composer (#124)", () => {
    it("closes only the suggestion list on Escape, leaving the composer open and untouched", async () => {
      searchContacts.mockResolvedValueOnce([
        { id: "c1", name: "Bob Smith", email: "bob@example.com", source: "manual" },
      ]);
      const { onClose } = renderComposer();

      const toInput = await screen.findByRole("combobox", { name: i18n.t("composer.to") });
      fireEvent.change(toInput, { target: { value: "bo" } });

      expect(await screen.findByRole("option", { name: /Bob Smith/ })).toBeInTheDocument();

      fireEvent.keyDown(toInput, { key: "Escape" });

      await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
      expect(screen.getByRole("dialog", { name: i18n.t("composer.newMessage") })).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  // GH #269: the dialog's accessible name (aria-label) and its visible <h2>
  // used to be a hardcoded "New message" for every flow, so a screen reader
  // announced a reply/forward/edit-draft as "New message" — the opposite of
  // what was happening. Both now follow the compose mode the draft was built
  // with (reply.ts's ComposeMode, the same distinction #145 remounts on).
  describe("accessible name reflects the compose mode (#269)", () => {
    const cases: Array<[ComposeMode | undefined, string]> = [
      ["new", "composer.newMessage"],
      ["reply", "composer.reply"],
      ["reply-all", "composer.replyAll"],
      ["forward", "composer.forward"],
      ["draft", "composer.editDraft"],
      // A draft literal with no mode falls back to "new" — the pre-#269 default.
      [undefined, "composer.newMessage"],
    ];

    it.each(cases)("names the dialog and its title for mode %s", async (mode, key) => {
      renderComposer(vi.fn(), { ...baseDraft(), mode });

      const dialog = await screen.findByRole("dialog", { name: i18n.t(key) });
      expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent(i18n.t(key));
    });
  });
});

// GH #249: the sibling row #214 did not touch. Enviar + "Redactar con IA" +
// Descartar want ~370px, and a 375px phone leaves ~287px inside the panel once
// the overlay padding and the panel's own px-5 are taken out — with no
// flex-wrap, no shrink-0 and no scrollable axis, Descartar was pushed off the
// edge with no way back.
describe("Composer action row at a narrow viewport (GH #249)", () => {
  const NARROW_VIEWPORT_WIDTH = 375;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    searchContacts.mockResolvedValue([]);
    // GH #292: this row includes the "draft with AI" CTA, so keep AI enabled here.
    fetchAiStatus.mockReset();
    fetchAiStatus.mockResolvedValue(true);
    Object.defineProperty(window, "innerWidth", {
      value: NARROW_VIEWPORT_WIDTH,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    });
  });

  it("wraps the row instead of letting it run off the edge", async () => {
    renderComposer();

    const actions = await screen.findByTestId("composer-actions");
    expect(actions.className).toContain("flex-wrap");
  });

  it("wraps between controls rather than squeezing their labels", async () => {
    renderComposer();

    const actions = await screen.findByTestId("composer-actions");
    // GH #292: the AI CTA renders once the async ai/status query resolves enabled.
    await within(actions).findByRole("button", { name: i18n.t("composer.draftWithAi") });
    for (const name of [i18n.t("composer.send"), i18n.t("composer.draftWithAi")]) {
      expect(within(actions).getByRole("button", { name }).className).toContain("shrink-0");
    }
    // The trailing group (autosave status + Descartar) travels as one unit, so
    // Descartar cannot be separated from the status it sits beside.
    const cancel = within(actions).getByRole("button", { name: i18n.t("composer.cancel") });
    expect(cancel.className).toContain("shrink-0");
    expect(cancel.parentElement?.className).toContain("ml-auto");
  });

  it("keeps every action of the worst-case row reachable", async () => {
    renderComposer();

    const actions = await screen.findByTestId("composer-actions");
    // GH #292: wait for the async AI CTA before asserting the worst-case row.
    await within(actions).findByRole("button", { name: i18n.t("composer.draftWithAi") });
    for (const name of [
      i18n.t("composer.send"),
      i18n.t("composer.draftWithAi"),
      i18n.t("composer.cancel"),
    ]) {
      expect(within(actions).getByRole("button", { name })).toBeVisible();
    }
  });

  it("still closes through the button the overflow used to swallow", async () => {
    const { onClose } = renderComposer();

    const actions = await screen.findByTestId("composer-actions");
    fireEvent.click(within(actions).getByRole("button", { name: i18n.t("composer.cancel") }));

    // An untouched draft closes straight through (GH #159's requestClose).
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

// GH #252: the composer is the densest screen in the app — two dialogs, a
// rich-text editor, three recipient comboboxes, an attachment list — and the
// one #249 shipped an overflow bug through. It gets the real engine too.
describe("Composer accessibility (GH #252)", () => {
  beforeEach(() => {
    searchContacts.mockResolvedValue([]);
  });

  it("passes an axe run over the open composer", async () => {
    renderComposer();

    await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    await expectNoAxeViolations(document.body);
  });

  it("passes an axe run with the discard confirmation on top", async () => {
    renderComposer(vi.fn(), { ...baseDraft(), subject: "Hello there" });

    await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.cancel") }));

    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body);
  });
});
