import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import type { ComposerDraft } from "./reply";
import { useComposer } from "./useComposer";

const { uploadAttachment, sendEmail, fetchAiDraft } = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  sendEmail: vi.fn(),
  fetchAiDraft: vi.fn(),
}));

vi.mock("./api", () => ({ uploadAttachment, sendEmail }));
vi.mock("./aiApi", () => ({ fetchAiDraft }));

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
});
