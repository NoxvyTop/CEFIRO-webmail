import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import type { ComposerDraft } from "./reply";
import { AUTOSAVE_DEBOUNCE_MS, useComposer } from "./useComposer";

const { uploadAttachment, sendEmail, fetchAiDraft, updateMessage, saveDraftApi } = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  sendEmail: vi.fn(),
  fetchAiDraft: vi.fn(),
  updateMessage: vi.fn(),
  saveDraftApi: vi.fn(),
}));

vi.mock("./api", () => ({ uploadAttachment, sendEmail, saveDraft: saveDraftApi }));
vi.mock("./aiApi", () => ({ fetchAiDraft }));
// Preserve the real MailApiError export (used elsewhere in this file) while
// injecting a mock for updateMessage, which delete-on-send calls.
vi.mock("../mailbox/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailbox/api")>();
  return { ...actual, updateMessage };
});

function baseDraft(): ComposerDraft {
  return {
    identityId: "id1",
    to: [],
    cc: [],
    bcc: [],
    subject: "Hi",
    bodyHtml: "<p>hello</p>",
  };
}

describe("useComposer", () => {
  it("addFiles: success path moves the upload into attachments and clears pending", async () => {
    uploadAttachment.mockResolvedValueOnce({ blobId: "blob1", type: "image/png", size: 5 });
    const { result } = renderHook(() => useComposer(baseDraft()));

    act(() => {
      result.current.addFiles([new File(["hello"], "a.png", { type: "image/png" })]);
    });

    expect(result.current.state.uploads).toHaveLength(1);

    await waitFor(() => expect(result.current.state.attachments).toHaveLength(1));
    expect(result.current.state.attachments[0]).toEqual({
      blobId: "blob1", name: "a.png", type: "image/png", size: 5,
    });
    expect(result.current.state.uploads).toHaveLength(0);
  });

  it("addFiles: error path marks the pending upload as errored", async () => {
    uploadAttachment.mockRejectedValueOnce(new MailApiError(500, "internal"));
    const { result } = renderHook(() => useComposer(baseDraft()));

    act(() => {
      result.current.addFiles([new File(["hello"], "b.png", { type: "image/png" })]);
    });

    await waitFor(() => expect(result.current.state.uploads[0]?.error).toBe(true));
    expect(result.current.state.attachments).toHaveLength(0);
    expect(result.current.state.uploads[0]?.name).toBe("b.png");
  });

  describe("addFiles: dedup (#114)", () => {
    // These tests assert exact uploadAttachment call counts, so the shared
    // mock (accumulated across earlier tests in this file) must start clean.
    beforeEach(() => {
      uploadAttachment.mockReset();
    });

    it("skips a file that duplicates an already-uploaded attachment (same name+size) and reports it as skipped", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "blob1", type: "image/png", size: 5 });
      const { result } = renderHook(() => useComposer(baseDraft()));

      act(() => {
        result.current.addFiles([new File(["hello"], "dup.png", { type: "image/png" })]);
      });
      await waitFor(() => expect(result.current.state.attachments).toHaveLength(1));

      let outcome: { skipped: string[] } | undefined;
      act(() => {
        outcome = result.current.addFiles([new File(["hello"], "dup.png", { type: "image/png" })]);
      });

      expect(outcome?.skipped).toEqual(["dup.png"]);
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(result.current.state.attachments).toHaveLength(1);
      expect(result.current.state.uploads).toHaveLength(0);
    });

    it("skips a file that duplicates an already-pending upload (same name+size, not yet resolved)", async () => {
      uploadAttachment.mockReturnValueOnce(new Promise(() => {})); // never resolves — stays pending
      const { result } = renderHook(() => useComposer(baseDraft()));

      act(() => {
        result.current.addFiles([new File(["hello"], "pending.png", { type: "image/png" })]);
      });
      expect(result.current.state.uploads).toHaveLength(1);

      let outcome: { skipped: string[] } | undefined;
      act(() => {
        outcome = result.current.addFiles([new File(["hello"], "pending.png", { type: "image/png" })]);
      });

      expect(outcome?.skipped).toEqual(["pending.png"]);
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(result.current.state.uploads).toHaveLength(1);
    });

    it("skips a duplicate within the same addFiles call (two identical files selected at once)", () => {
      uploadAttachment.mockReturnValueOnce(new Promise(() => {}));
      const { result } = renderHook(() => useComposer(baseDraft()));

      let outcome: { skipped: string[] } | undefined;
      act(() => {
        outcome = result.current.addFiles([
          new File(["hello"], "same.png", { type: "image/png" }),
          new File(["hello"], "same.png", { type: "image/png" }),
        ]);
      });

      expect(outcome?.skipped).toEqual(["same.png"]);
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(result.current.state.uploads).toHaveLength(1);
    });

    it("does not skip files with the same name but a different size", async () => {
      uploadAttachment.mockResolvedValueOnce({ blobId: "blob1", type: "image/png", size: 5 });
      uploadAttachment.mockResolvedValueOnce({ blobId: "blob2", type: "image/png", size: 9 });
      const { result } = renderHook(() => useComposer(baseDraft()));

      act(() => {
        result.current.addFiles([new File(["hello"], "same-name.png", { type: "image/png" })]);
      });
      await waitFor(() => expect(result.current.state.attachments).toHaveLength(1));

      let outcome: { skipped: string[] } | undefined;
      act(() => {
        outcome = result.current.addFiles([
          new File(["hello world"], "same-name.png", { type: "image/png" }),
        ]);
      });

      expect(outcome?.skipped).toEqual([]);
      await waitFor(() => expect(result.current.state.attachments).toHaveLength(2));
    });
  });

  it("send: without a recipient sets noRecipients error and does not call sendEmail", async () => {
    const { result } = renderHook(() => useComposer(baseDraft()));

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send();
    });

    expect(sent).toBe(false);
    expect(result.current.state.sendError).toBe("composer.errors.noRecipients");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("send: happy path calls sendEmail with the mapped input and returns true", async () => {
    sendEmail.mockResolvedValueOnce(undefined);
    const draft: ComposerDraft = {
      ...baseDraft(),
      to: [{ name: "Bob", email: "bob@example.com" }],
    };
    const { result } = renderHook(() => useComposer(draft));

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send();
    });

    expect(sent).toBe(true);
    expect(result.current.state.sending).toBe(false);
    expect(result.current.state.sendError).toBeNull();
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        identityId: "id1",
        to: [{ name: "Bob", email: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        attachments: [],
      }),
    );
  });

  it("send: strips internal signature/quote marker attributes from the outgoing htmlBody", async () => {
    sendEmail.mockResolvedValueOnce(undefined);
    const draft: ComposerDraft = {
      ...baseDraft(),
      to: [{ name: "Bob", email: "bob@example.com" }],
      bodyHtml:
        '<p>Hi</p><div data-cefiro-signature="true"><p>Thanks, Alice</p></div>' +
        '<div data-cefiro-quote="true"><blockquote><p>Original</p></blockquote></div>',
    };
    const { result } = renderHook(() => useComposer(draft));

    await act(async () => {
      await result.current.send();
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        htmlBody: "<p>Hi</p><p>Thanks, Alice</p><blockquote><p>Original</p></blockquote>",
      }),
    );
    const sentHtml = sendEmail.mock.calls[0]?.[0]?.htmlBody as string;
    expect(sentHtml).not.toContain("data-cefiro-signature");
    expect(sentHtml).not.toContain("data-cefiro-quote");
  });

  // GH #120: guards the wire seam between the composer draft and the send
  // payload — deleting the inReplyTo/references mapping in useComposer.send
  // would otherwise make the whole threading feature a silent no-op. The
  // assertions read the captured argument directly rather than through
  // expect.objectContaining, which also matches when a key is absent.
  describe("send: RFC 5322 threading headers reach the sendEmail payload", () => {
    beforeEach(() => {
      sendEmail.mockReset();
    });

    it("forwards the draft's inReplyTo and references verbatim", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      const draft: ComposerDraft = {
        ...baseDraft(),
        to: [{ name: "Bob", email: "bob@example.com" }],
        inReplyTo: ["parent@example.com"],
        references: ["grandparent@example.com", "parent@example.com"],
      };
      const { result } = renderHook(() => useComposer(draft));

      await act(async () => {
        await result.current.send();
      });

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const payload = sendEmail.mock.calls[0]?.[0] as {
        inReplyTo?: string[];
        references?: string[];
      };
      expect(payload.inReplyTo).toEqual(["parent@example.com"]);
      expect(payload.references).toEqual(["grandparent@example.com", "parent@example.com"]);
    });

    it("leaves both undefined on the payload for a non-reply draft", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      const draft: ComposerDraft = {
        ...baseDraft(),
        to: [{ name: "Bob", email: "bob@example.com" }],
      };
      const { result } = renderHook(() => useComposer(draft));

      await act(async () => {
        await result.current.send();
      });

      const payload = sendEmail.mock.calls[0]?.[0] as {
        inReplyTo?: string[];
        references?: string[];
      };
      expect(payload.inReplyTo).toBeUndefined();
      expect(payload.references).toBeUndefined();
    });
  });

  it("send: maps MailApiError to a namespaced error code and returns false", async () => {
    sendEmail.mockRejectedValueOnce(new MailApiError(503, "mail_not_configured"));
    const draft: ComposerDraft = {
      ...baseDraft(),
      to: [{ name: "Bob", email: "bob@example.com" }],
    };
    const { result } = renderHook(() => useComposer(draft));

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send();
    });

    expect(sent).toBe(false);
    expect(result.current.state.sending).toBe(false);
    expect(result.current.state.sendError).toBe("composer.errors.mail_not_configured");
  });

  describe("draftWithAi", () => {
    it("does not call the endpoint and sets a needs-subject error when subject is blank", async () => {
      const draft: ComposerDraft = { ...baseDraft(), subject: "  " };
      const { result } = renderHook(() => useComposer(draft));

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(fetchAiDraft).not.toHaveBeenCalled();
      expect(result.current.state.aiDraftError).toBe("composer.aiDraftNeedsSubject");
    });

    it("happy path fills the body and shows the review notice", async () => {
      fetchAiDraft.mockResolvedValueOnce("Estimado equipo, este es el borrador.");
      const { result } = renderHook(() => useComposer(baseDraft()));

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(fetchAiDraft).toHaveBeenCalledWith("Hi");
      expect(result.current.state.aiDrafting).toBe(false);
      expect(result.current.state.aiDraftError).toBeNull();
      expect(result.current.state.aiDraftNotice).toBe(true);
      expect(result.current.state.draft.bodyHtml).toContain("Estimado equipo, este es el borrador.");
    });

    it("hides the feature (aiUnavailable) without an inline error when the backend reports ai_disabled", async () => {
      fetchAiDraft.mockRejectedValueOnce(new MailApiError(501, "ai_disabled"));
      const { result } = renderHook(() => useComposer(baseDraft()));

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(result.current.state.aiUnavailable).toBe(true);
      expect(result.current.state.aiDraftError).toBeNull();
      expect(result.current.state.aiDrafting).toBe(false);
    });

    it("maps other provider failures to a namespaced inline error", async () => {
      fetchAiDraft.mockRejectedValueOnce(new MailApiError(502, "ai_provider_error"));
      const { result } = renderHook(() => useComposer(baseDraft()));

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(result.current.state.aiUnavailable).toBe(false);
      expect(result.current.state.aiDraftError).toBe("composer.errors.ai_provider_error");
    });
  });

  // NEW for feat/v3-edit-draft — kept in its own describe block, isolated
  // from the pre-existing send/draftWithAi tests above.
  describe("send: delete-on-send for an edited draft (originalDraftId + trashMailboxId)", () => {
    beforeEach(() => {
      updateMessage.mockReset();
    });

    function draftWithOriginal(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
      return {
        ...baseDraft(),
        to: [{ name: "Bob", email: "bob@example.com" }],
        originalDraftId: "orig-draft-1",
        ...overrides,
      };
    }

    it("moves the original draft to Trash after a successful send when both originalDraftId and trashMailboxId are present", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      updateMessage.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useComposer(draftWithOriginal(), "trash1"));

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).toHaveBeenCalledWith("orig-draft-1", { mailboxIds: { trash1: true } });
    });

    it("does not call updateMessage when the draft has no originalDraftId (a brand new email)", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() =>
        useComposer({ ...baseDraft(), to: [{ name: "Bob", email: "bob@example.com" }] }, "trash1"),
      );

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).not.toHaveBeenCalled();
    });

    it("does not call updateMessage when no trashMailboxId is supplied", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useComposer(draftWithOriginal()));

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).not.toHaveBeenCalled();
    });

    it("still reports the send as successful even if trashing the original draft fails (best-effort cleanup)", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      updateMessage.mockRejectedValueOnce(new MailApiError(500, "internal"));
      const { result } = renderHook(() => useComposer(draftWithOriginal(), "trash1"));

      let sent: boolean | undefined;
      await act(async () => {
        sent = await result.current.send();
      });

      expect(sent).toBe(true);
      expect(result.current.state.sendError).toBeNull();
    });

    it("does not call updateMessage when the send itself fails", async () => {
      sendEmail.mockRejectedValueOnce(new MailApiError(503, "mail_not_configured"));
      const { result } = renderHook(() => useComposer(draftWithOriginal(), "trash1"));

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).not.toHaveBeenCalled();
    });
  });

  // GH #125: saveDraft() wires composer/api.ts's saveDraft into useComposer,
  // reusing send()'s payload construction (identity, recipients, subject,
  // plain-text derivation, attachments, threading headers). GH #156: the one
  // deliberate difference is htmlBody — send() strips the internal
  // signature/quote markers (see buildComposePayload's stripMarkers option),
  // saveDraft() does not, so a reopened draft can still find its previously
  // applied signature instead of duplicating it.
  describe("saveDraft (#125)", () => {
    beforeEach(() => {
      saveDraftApi.mockReset();
    });

    it("happy path calls the saveDraft API with the mapped input and returns true", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      const draft: ComposerDraft = {
        ...baseDraft(),
        to: [{ name: "Bob", email: "bob@example.com" }],
      };
      const { result } = renderHook(() => useComposer(draft));

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.saveDraft();
      });

      expect(ok).toBe(true);
      expect(result.current.state.savingDraft).toBe(false);
      expect(result.current.state.saveDraftError).toBeNull();
      expect(saveDraftApi).toHaveBeenCalledWith(
        expect.objectContaining({
          identityId: "id1",
          to: [{ name: "Bob", email: "bob@example.com" }],
          cc: [],
          bcc: [],
          subject: "Hi",
          attachments: [],
        }),
      );
    });

    it("does not require a recipient — a draft is work in progress (GH #149)", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      const { result } = renderHook(() => useComposer(baseDraft()));

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.saveDraft();
      });

      expect(ok).toBe(true);
      expect(result.current.state.saveDraftError).toBeNull();
    });

    // GH #156: saveDraft() deliberately does NOT strip the internal
    // signature/quote marker divs, unlike send(). Stripping them here used
    // to be the root cause of a reopened draft's signature duplicating —
    // with the marker gone, the next auto-apply had no way to find the
    // previously-applied signature and appended a second copy instead of
    // replacing it (see signature-integrity.test.ts for the full
    // save -> reopen -> auto-apply regression coverage). A saved draft is
    // never recipient-facing — only an actual send is — so keeping the
    // marker in a draft's persisted body is safe and, per GH #156, required.
    it("preserves internal signature/quote marker attributes in the persisted draft body, unlike send", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      const draft: ComposerDraft = {
        ...baseDraft(),
        bodyHtml:
          '<p>Hi</p><div data-cefiro-signature="true"><p>Thanks, Alice</p></div>' +
          '<div data-cefiro-quote="true"><blockquote><p>Original</p></blockquote></div>',
      };
      const { result } = renderHook(() => useComposer(draft));

      await act(async () => {
        await result.current.saveDraft();
      });

      const sentHtml = saveDraftApi.mock.calls[0]?.[0]?.htmlBody as string;
      expect(sentHtml).toBe(draft.bodyHtml);
      expect(sentHtml).toContain("data-cefiro-signature");
      expect(sentHtml).toContain("data-cefiro-quote");
    });

    it("carries originalDraftId through to the saveDraft payload when editing an existing draft", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      const draft: ComposerDraft = { ...baseDraft(), originalDraftId: "orig-1" };
      const { result } = renderHook(() => useComposer(draft));

      await act(async () => {
        await result.current.saveDraft();
      });

      expect(saveDraftApi).toHaveBeenCalledWith(expect.objectContaining({ originalDraftId: "orig-1" }));
    });

    it("maps MailApiError to a namespaced error code and returns false, keeping the draft intact", async () => {
      saveDraftApi.mockRejectedValueOnce(new MailApiError(500, "save_draft_failed"));
      const draft: ComposerDraft = { ...baseDraft(), subject: "Keep me" };
      const { result } = renderHook(() => useComposer(draft));

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.saveDraft();
      });

      expect(ok).toBe(false);
      expect(result.current.state.savingDraft).toBe(false);
      expect(result.current.state.saveDraftError).toBe("composer.errors.save_draft_failed");
      // The draft itself is untouched by a failed save — losing the user's
      // work while trying to save it would be the worst possible outcome.
      expect(result.current.state.draft.subject).toBe("Keep me");
    });

    it("does not call the API a second time when saveDraft is invoked again while the first call is still in flight", async () => {
      let resolveFirst: (value: { id: string }) => void = () => {};
      saveDraftApi.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const { result } = renderHook(() => useComposer(baseDraft()));

      let firstResult: Promise<boolean> = Promise.resolve(false);
      let secondResult: boolean | undefined;
      act(() => {
        firstResult = result.current.saveDraft();
        void result.current.saveDraft().then((value) => {
          secondResult = value;
        });
      });

      expect(saveDraftApi).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirst({ id: "draft-1" });
        await firstResult;
      });

      expect(secondResult).toBe(false);
    });
  });

  // GH #178: debounced autosave of the in-progress draft. The delicate part
  // isn't the timer — it's identity and coalescence: only one save in flight at
  // a time, each save superseding the draft the previous one created (POST
  // /drafts is create-then-replace, not update — RFC 8620 §5.3) so a burst of
  // edits leaves exactly one draft, never a pile of duplicates.
  describe("autosave (#178)", () => {
    function emptyDraft(): ComposerDraft {
      return { identityId: "id1", to: [], cc: [], bcc: [], subject: "", bodyHtml: "" };
    }

    // Chained promise continuations (persistDraft → coalescing loop → dispatch)
    // settle across several microtask turns; flush enough of them that the
    // assertions see the final state under fake timers.
    async function flushMicrotasks() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }

    beforeEach(() => {
      saveDraftApi.mockReset();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("autosaves after the idle debounce once meaningful content is typed", async () => {
      saveDraftApi.mockResolvedValue({ id: "draft-1" });
      const { result } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "Reunión de mañana");
      });
      // Debounced: nothing is saved on the keystroke itself.
      expect(saveDraftApi).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });

      expect(saveDraftApi).toHaveBeenCalledTimes(1);
      expect(saveDraftApi).toHaveBeenCalledWith(
        expect.objectContaining({ subject: "Reunión de mañana" }),
      );
      expect(result.current.state.autosaveStatus).toBe("saved");
    });

    it("does not autosave an empty draft (only whitespace typed)", async () => {
      const { result } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "   ");
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
      });

      expect(saveDraftApi).not.toHaveBeenCalled();
      expect(result.current.state.autosaveStatus).toBe("idle");
    });

    it("supersedes the same draft on the next save instead of creating a duplicate", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      saveDraftApi.mockResolvedValueOnce({ id: "draft-2" });
      const { result } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "First");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });

      // The first save is a fresh create — no draft to supersede yet.
      expect(saveDraftApi.mock.calls[0]?.[0]?.originalDraftId).toBeUndefined();

      act(() => {
        result.current.setField("subject", "Second");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });

      expect(saveDraftApi).toHaveBeenCalledTimes(2);
      // The second save carries the id the first one created, so the server
      // replaces that draft rather than leaving two behind.
      expect(saveDraftApi.mock.calls[1]?.[0]?.originalDraftId).toBe("draft-1");
      expect(saveDraftApi.mock.calls[1]?.[0]?.subject).toBe("Second");
    });

    it("reflects saving then saved in the autosave indicator status", async () => {
      let resolveSave: (value: { id: string }) => void = () => {};
      saveDraftApi.mockImplementationOnce(
        () => new Promise((resolve) => { resolveSave = resolve; }),
      );
      const { result } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "Reunión");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });

      // Parked on the in-flight request.
      expect(result.current.state.autosaveStatus).toBe("saving");

      await act(async () => {
        resolveSave({ id: "draft-1" });
        await flushMicrotasks();
      });

      expect(result.current.state.autosaveStatus).toBe("saved");
    });

    it("surfaces an error status when the autosave request fails", async () => {
      saveDraftApi.mockRejectedValueOnce(new MailApiError(500, "save_draft_failed"));
      const { result } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "Reunión");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        await flushMicrotasks();
      });

      expect(result.current.state.autosaveStatus).toBe("error");
    });

    it("coalesces an edit made mid-save into a single follow-up, without overlapping or duplicating", async () => {
      let resolveFirst: (value: { id: string }) => void = () => {};
      saveDraftApi
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce({ id: "draft-2" });
      const { result } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "First");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });
      expect(saveDraftApi).toHaveBeenCalledTimes(1);
      expect(result.current.state.autosaveStatus).toBe("saving");

      // Edit again while the first save is still in flight, and let its debounce
      // fire: no second request goes out on top of the running one.
      act(() => {
        result.current.setField("subject", "Second");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });
      expect(saveDraftApi).toHaveBeenCalledTimes(1);

      // First settles → the coalesced follow-up runs with the latest content,
      // superseding the draft the first save created.
      await act(async () => {
        resolveFirst({ id: "draft-1" });
        await flushMicrotasks();
      });

      expect(saveDraftApi).toHaveBeenCalledTimes(2);
      expect(saveDraftApi.mock.calls[1]?.[0]?.subject).toBe("Second");
      expect(saveDraftApi.mock.calls[1]?.[0]?.originalDraftId).toBe("draft-1");
      expect(result.current.state.autosaveStatus).toBe("saved");
    });

    // GH #176: an exit route that never runs through requestClose (the header's
    // home link clears the compose param and unmounts the composer) must still
    // not drop the draft. The unmount flush persists it on the way out.
    it("flushes unsaved content on unmount, before the debounce would have fired (#176)", async () => {
      saveDraftApi.mockResolvedValue({ id: "draft-1" });
      const { result, unmount } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "Do not lose me");
      });
      // Torn down well before AUTOSAVE_DEBOUNCE_MS elapses.
      expect(saveDraftApi).not.toHaveBeenCalled();

      unmount();

      expect(saveDraftApi).toHaveBeenCalledTimes(1);
      expect(saveDraftApi).toHaveBeenCalledWith(
        expect.objectContaining({ subject: "Do not lose me" }),
      );
    });

    it("does not flush on unmount when the draft is empty", async () => {
      const { result, unmount } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "   ");
      });
      unmount();

      expect(saveDraftApi).not.toHaveBeenCalled();
    });

    // Guards against the unmount flush recreating the message as a draft after
    // it was actually sent (send → onClose → unmount).
    it("does not resave the message as a draft on unmount after a successful send", async () => {
      sendEmail.mockReset();
      sendEmail.mockResolvedValueOnce(undefined);
      const { result, unmount } = renderHook(() =>
        useComposer({ ...emptyDraft(), to: [{ name: null, email: "bob@example.com" }] }),
      );

      act(() => {
        result.current.setField("subject", "Sent, not a draft");
      });
      await act(async () => {
        await result.current.send();
      });
      expect(result.current.state.sendError).toBeNull();

      unmount();

      expect(saveDraftApi).not.toHaveBeenCalled();
    });

    // Guards against the unmount flush re-saving a draft the user explicitly
    // discarded (Discard anyway → onClose → unmount).
    it("does not resave a discarded draft on unmount", async () => {
      const { result, unmount } = renderHook(() => useComposer(emptyDraft()));

      act(() => {
        result.current.setField("subject", "Throw me away");
      });
      act(() => {
        result.current.discardDraft();
      });
      unmount();

      expect(saveDraftApi).not.toHaveBeenCalled();
    });
  });
});
