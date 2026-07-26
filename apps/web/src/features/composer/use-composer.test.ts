import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import type { ComposerDraft } from "./reply";
import { useComposer } from "./useComposer";

const { uploadAttachment, sendEmail, fetchAiDraft, updateMessage } = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  sendEmail: vi.fn(),
  fetchAiDraft: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock("./api", () => ({ uploadAttachment, sendEmail }));
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
});
