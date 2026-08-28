import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

// GH #336: send() and persistDraft() now invalidate through useQueryClient,
// so every renderHook below needs a real QueryClient in scope — a fresh one
// per test (reset in beforeEach) so invalidation call counts asserted in one
// test never leak into the next. Kept as a plain function component (not
// JSX) so this file can stay .ts rather than becoming .tsx for one wrapper.
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

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
    const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
    const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
    const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
    const { result } = renderHook(() => useComposer(draft), { wrapper });

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

  // GH #336: Sent/Drafts and the sidebar's unread counters used to refresh
  // only via the SSE stream (useMailEvents.ts) or the browser's default
  // refetchOnWindowFocus — invisible if the tab is over the per-user stream
  // cap or the SSE connection is otherwise degraded. A successful send now
  // invalidates the same query keys ThreadView's own mutations already do
  // (see reader/ThreadView.tsx's starMutation), so Sent/Drafts and the
  // mailbox counters are correct the instant send() resolves, independent of
  // any stream.
  it("send: invalidates email and mailbox queries on success (#336)", async () => {
    sendEmail.mockResolvedValueOnce(undefined);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const draft: ComposerDraft = {
      ...baseDraft(),
      to: [{ name: "Bob", email: "bob@example.com" }],
    };
    const { result } = renderHook(() => useComposer(draft), { wrapper });

    await act(async () => {
      await result.current.send();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "messages"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "thread"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "mailboxes"] });
  });

  it("send: does not invalidate anything when the send fails", async () => {
    sendEmail.mockRejectedValueOnce(new MailApiError(503, "mail_not_configured"));
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const draft: ComposerDraft = {
      ...baseDraft(),
      to: [{ name: "Bob", email: "bob@example.com" }],
    };
    const { result } = renderHook(() => useComposer(draft), { wrapper });

    await act(async () => {
      await result.current.send();
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
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
    const { result } = renderHook(() => useComposer(draft), { wrapper });

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
      const { result } = renderHook(() => useComposer(draft), { wrapper });

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
      const { result } = renderHook(() => useComposer(draft), { wrapper });

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
    const { result } = renderHook(() => useComposer(draft), { wrapper });

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send();
    });

    expect(sent).toBe(false);
    expect(result.current.state.sending).toBe(false);
    expect(result.current.state.sendError).toBe("composer.errors.mail_not_configured");
  });

  describe("draftWithAi", () => {
    // GH #304: subject is no longer required — the body IS the intent. An empty
    // body means there is nothing to expand, so the hook surfaces guidance
    // instead of calling the API from the subject alone.
    it("does not call the endpoint and surfaces needs-intent guidance when the body is empty", async () => {
      // A subject is present but the body is empty — the old gate would have let
      // this through; the new one must not.
      const draft: ComposerDraft = { ...baseDraft(), subject: "Reunión", bodyHtml: "   " };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(fetchAiDraft).not.toHaveBeenCalled();
      expect(result.current.state.aiDraftError).toBe("composer.aiDraftNeedsIntent");
    });

    it("happy path uses the typed body as the intent, fills the body and shows the review notice", async () => {
      fetchAiDraft.mockResolvedValueOnce("Estimado equipo, este es el borrador.");
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

      await act(async () => {
        await result.current.draftWithAi();
      });

      // The typed body ("hello") is the intent; the subject is a hint; a
      // brand-new compose (no quoted original) sends no context.
      expect(fetchAiDraft).toHaveBeenCalledWith({ intent: "hello", subject: "Hi", context: undefined });
      expect(result.current.state.aiDrafting).toBe(false);
      expect(result.current.state.aiDraftError).toBeNull();
      expect(result.current.state.aiDraftNotice).toBe(true);
      expect(result.current.state.draft.bodyHtml).toContain("Estimado equipo, este es el borrador.");
    });

    it("omits the subject hint when the subject is blank", async () => {
      fetchAiDraft.mockClear();
      fetchAiDraft.mockResolvedValueOnce("Borrador.");
      const draft: ComposerDraft = { ...baseDraft(), subject: "   ", bodyHtml: "<p>quiero avisar que no voy</p>" };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(fetchAiDraft).toHaveBeenCalledWith({
        intent: "quiero avisar que no voy",
        subject: undefined,
        context: undefined,
      });
    });

    // GH #299 / #304: on a reply the composer carries the message being replied
    // to as the quoted tail of the body. The user's typed text (above the quote)
    // is the intent; the quoted original is forwarded as `context` and kept in
    // the body after the draft is generated.
    it("passes the typed text as intent and the quoted original as context on a reply, keeping the quote", async () => {
      // The mock is shared across this file's tests — clear its accumulated call
      // history so the count/args below describe only this test's own call.
      fetchAiDraft.mockClear();
      fetchAiDraft.mockResolvedValueOnce("Estimado equipo, respuesta generada.");
      const replyDraft: ComposerDraft = {
        ...baseDraft(),
        subject: "Re: Presupuesto",
        bodyHtml:
          "<p>Hola equipo</p>" +
          '<div data-cefiro-quote="true"><p>2026-07-01 — Alice:</p>' +
          "<blockquote><p>¿Puedes confirmar el total antes del viernes?</p></blockquote></div>",
      };
      const { result } = renderHook(() => useComposer(replyDraft), { wrapper });

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(fetchAiDraft).toHaveBeenCalledTimes(1);
      const [input] = fetchAiDraft.mock.calls[0] as [{ intent: string; subject?: string; context?: string }];
      expect(input.subject).toBe("Re: Presupuesto");
      // The user's typed text above the quote is the intent…
      expect(input.intent).toBe("Hola equipo");
      // …and the quoted original is the context, not the typed text.
      expect(input.context).toContain("¿Puedes confirmar el total antes del viernes?");
      expect(input.context).not.toContain("Hola equipo");
      // The generated draft replaces the editable body but keeps the quoted tail.
      expect(result.current.state.draft.bodyHtml).toContain("Estimado equipo, respuesta generada.");
      expect(result.current.state.draft.bodyHtml).toContain("data-cefiro-quote");
      expect(result.current.state.draft.bodyHtml).toContain("¿Puedes confirmar el total antes del viernes?");
    });

    // The original bug (GH #304): regenerating appeared to "remember" the first
    // output because the draft was driven by the subject, not the body. Now each
    // run reads the current body, so a changed body produces a changed intent.
    it("reflects the current body on each run instead of remembering the first", async () => {
      fetchAiDraft.mockClear();
      fetchAiDraft.mockResolvedValueOnce("Primer borrador.");
      fetchAiDraft.mockResolvedValueOnce("Segundo borrador.");
      const { result } = renderHook(
        () => useComposer({ ...baseDraft(), subject: "Hi", bodyHtml: "<p>primera idea</p>" }),
        { wrapper },
      );

      await act(async () => {
        await result.current.draftWithAi();
      });
      expect(fetchAiDraft).toHaveBeenLastCalledWith({
        intent: "primera idea",
        subject: "Hi",
        context: undefined,
      });

      act(() => {
        result.current.setField("bodyHtml", "<p>segunda idea distinta</p>");
      });
      await act(async () => {
        await result.current.draftWithAi();
      });
      expect(fetchAiDraft).toHaveBeenLastCalledWith({
        intent: "segunda idea distinta",
        subject: "Hi",
        context: undefined,
      });
    });

    it("hides the feature (aiUnavailable) without an inline error when the backend reports ai_disabled", async () => {
      fetchAiDraft.mockRejectedValueOnce(new MailApiError(501, "ai_disabled"));
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

      await act(async () => {
        await result.current.draftWithAi();
      });

      expect(result.current.state.aiUnavailable).toBe(true);
      expect(result.current.state.aiDraftError).toBeNull();
      expect(result.current.state.aiDrafting).toBe(false);
    });

    it("maps other provider failures to a namespaced inline error", async () => {
      fetchAiDraft.mockRejectedValueOnce(new MailApiError(502, "ai_provider_error"));
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(draftWithOriginal(), "trash1"), { wrapper });

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).toHaveBeenCalledWith("orig-draft-1", { mailboxIds: { trash1: true } });
    });

    it("does not call updateMessage when the draft has no originalDraftId (a brand new email)", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      const { result } = renderHook(
        () => useComposer({ ...baseDraft(), to: [{ name: "Bob", email: "bob@example.com" }] }, "trash1"),
        { wrapper },
      );

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).not.toHaveBeenCalled();
    });

    it("does not call updateMessage when no trashMailboxId is supplied", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useComposer(draftWithOriginal()), { wrapper });

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).not.toHaveBeenCalled();
    });

    it("still reports the send as successful even if trashing the original draft fails (best-effort cleanup)", async () => {
      sendEmail.mockResolvedValueOnce(undefined);
      updateMessage.mockRejectedValueOnce(new MailApiError(500, "internal"));
      const { result } = renderHook(() => useComposer(draftWithOriginal(), "trash1"), { wrapper });

      let sent: boolean | undefined;
      await act(async () => {
        sent = await result.current.send();
      });

      expect(sent).toBe(true);
      expect(result.current.state.sendError).toBeNull();
    });

    it("does not call updateMessage when the send itself fails", async () => {
      sendEmail.mockRejectedValueOnce(new MailApiError(503, "mail_not_configured"));
      const { result } = renderHook(() => useComposer(draftWithOriginal(), "trash1"), { wrapper });

      await act(async () => {
        await result.current.send();
      });

      expect(updateMessage).not.toHaveBeenCalled();
    });
  });

  // GH #141: the text/plain alternative of a reply must mark the quoted
  // conversation. It used to be derived from the marker-STRIPPED html, which
  // removed the very attribute the quote is found by, so the quote reached
  // plain-text readers indistinguishable from what the user had just typed.
  describe("outgoing text/plain quoting (#141)", () => {
    const REPLY_BODY =
      "<p>Sounds good to me.</p>" +
      '<div data-cefiro-quote="true"><p>2026-07-01 — Alice:</p>' +
      "<blockquote><p>Can you confirm the numbers?</p></blockquote></div>";

    // These assert on the FIRST recorded payload, so the shared module-level
    // mock (accumulated by earlier tests in this file) must start clean.
    beforeEach(() => {
      sendEmail.mockReset();
    });

    it("prefixes the quoted original with '>' while leaving the new text alone", async () => {
      sendEmail.mockResolvedValueOnce({ id: "m1" });
      const draft: ComposerDraft = {
        ...baseDraft(),
        bodyHtml: REPLY_BODY,
        to: [{ name: null, email: "alice@example.com" }],
      };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.send();
      });

      const payload = sendEmail.mock.calls[0]?.[0] as { textBody: string; htmlBody: string };
      expect(payload.textBody).toContain("Sounds good to me.");
      expect(payload.textBody).toContain("> Can you confirm the numbers?");
      expect(payload.textBody).not.toContain("> Sounds good to me.");
      // The HTML alternative is still the marker-stripped one — the two
      // alternatives are derived from different inputs on purpose.
      expect(payload.htmlBody).not.toContain("data-cefiro-quote");
    });

    it("leaves a brand-new message's text body unquoted", async () => {
      sendEmail.mockResolvedValueOnce({ id: "m2" });
      const draft: ComposerDraft = {
        ...baseDraft(),
        bodyHtml: "<p>Just saying hi</p>",
        to: [{ name: null, email: "alice@example.com" }],
      };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.send();
      });

      const payload = sendEmail.mock.calls[0]?.[0] as { textBody: string };
      expect(payload.textBody).toBe("Just saying hi");
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
      const { result } = renderHook(() => useComposer(draft), { wrapper });

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
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.saveDraft();
      });

      const sentHtml = saveDraftApi.mock.calls[0]?.[0]?.htmlBody as string;
      expect(sentHtml).toBe(draft.bodyHtml);
      expect(sentHtml).toContain("data-cefiro-signature");
      expect(sentHtml).toContain("data-cefiro-quote");
    });

    // GH #336: saveDraft() routes through the same persistDraft() autosave
    // uses, so both refresh Drafts/the sidebar counters on success without
    // waiting on SSE.
    it("invalidates email and mailbox queries on success (#336)", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      const draft: ComposerDraft = { ...baseDraft(), to: [{ name: "Bob", email: "bob@example.com" }] };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.saveDraft();
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "messages"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "thread"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "mailboxes"] });
    });

    it("does not invalidate anything when the save fails", async () => {
      saveDraftApi.mockRejectedValueOnce(new MailApiError(500, "save_draft_failed"));
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

      await act(async () => {
        await result.current.saveDraft();
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it("carries originalDraftId through to the saveDraft payload when editing an existing draft", async () => {
      saveDraftApi.mockResolvedValueOnce({ id: "draft-1" });
      const draft: ComposerDraft = { ...baseDraft(), originalDraftId: "orig-1" };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

      await act(async () => {
        await result.current.saveDraft();
      });

      expect(saveDraftApi).toHaveBeenCalledWith(expect.objectContaining({ originalDraftId: "orig-1" }));
    });

    it("maps MailApiError to a namespaced error code and returns false, keeping the draft intact", async () => {
      saveDraftApi.mockRejectedValueOnce(new MailApiError(500, "save_draft_failed"));
      const draft: ComposerDraft = { ...baseDraft(), subject: "Keep me" };
      const { result } = renderHook(() => useComposer(draft), { wrapper });

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
      const { result } = renderHook(() => useComposer(baseDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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

    // GH #336: autosave shares persistDraft() with the explicit "Save to
    // drafts" action, so a debounced autosave also keeps Drafts/the sidebar
    // counters fresh.
    it("invalidates email and mailbox queries after a debounced autosave (#336)", async () => {
      saveDraftApi.mockResolvedValue({ id: "draft-1" });
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

      act(() => {
        result.current.setField("subject", "Reunión de mañana");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "messages"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "thread"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mail", "mailboxes"] });
    });

    it("does not autosave an empty draft (only whitespace typed)", async () => {
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result, unmount } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result, unmount } = renderHook(() => useComposer(emptyDraft()), { wrapper });

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
      const { result, unmount } = renderHook(
        () => useComposer({ ...emptyDraft(), to: [{ name: null, email: "bob@example.com" }] }),
        { wrapper },
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
      const { result, unmount } = renderHook(() => useComposer(emptyDraft()), { wrapper });

      act(() => {
        result.current.setField("subject", "Throw me away");
      });
      act(() => {
        result.current.discardDraft();
      });
      unmount();

      expect(saveDraftApi).not.toHaveBeenCalled();
    });

    // GH #278: send() trashes the draft copy currently sitting in Drafts, read
    // from currentDraftIdRef. An autosave in flight is about to advance that id
    // to the fresh copy it is writing (persistDraft), so reading it too early
    // trashes the id being superseded and leaves the fresh copy orphaned. send()
    // now awaits the in-flight autosave first, so the id it trashes is the one
    // that actually ends up in Drafts.
    it("awaits an in-flight autosave and trashes the copy it created, leaving no orphan (#278)", async () => {
      sendEmail.mockReset();
      updateMessage.mockReset();
      sendEmail.mockResolvedValueOnce(undefined);
      updateMessage.mockResolvedValueOnce(undefined);
      // Hold the autosave's request open so it is genuinely in flight when send()
      // runs, then release it to the id of the copy it created.
      let resolveAutosave: (value: { id: string }) => void = () => {};
      saveDraftApi.mockImplementationOnce(
        () => new Promise((resolve) => { resolveAutosave = resolve; }),
      );

      const { result } = renderHook(
        () => useComposer({ ...emptyDraft(), to: [{ name: null, email: "bob@example.com" }] }, "trash1"),
        { wrapper },
      );

      act(() => {
        result.current.setField("subject", "Reunión");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      });
      // Parked on the in-flight request: the copy's id has not landed yet, so a
      // send() reading currentDraftIdRef right now would see the stale (unset) id.
      expect(saveDraftApi).toHaveBeenCalledTimes(1);
      expect(result.current.state.autosaveStatus).toBe("saving");

      let sendResult: boolean | undefined;
      await act(async () => {
        const sendPromise = result.current.send();
        resolveAutosave({ id: "autosaved-copy" });
        sendResult = await sendPromise;
        await flushMicrotasks();
      });

      expect(sendResult).toBe(true);
      // Exactly the copy the autosave created is trashed — one call, no orphan.
      expect(updateMessage).toHaveBeenCalledTimes(1);
      expect(updateMessage).toHaveBeenCalledWith("autosaved-copy", {
        mailboxIds: { trash1: true },
      });
    });

    // GH #145 keys <Composer> on the compose param, which turns "switch compose
    // target" into unmount-then-mount. That lands directly on top of the two
    // draft mechanisms living in this hook — the GH #176 unmount flush and GH
    // #178 autosave — so the interaction is asserted here rather than assumed:
    // the outgoing session must persist its own work exactly once, and the
    // incoming one must start from its own `initial` without adopting, resaving
    // or duplicating the previous draft.
    describe("remount on a new compose target (GH #145)", () => {
      function draftFor(subject: string, originalDraftId?: string): ComposerDraft {
        return { identityId: "id1", to: [], cc: [], bcc: [], subject, bodyHtml: "", originalDraftId };
      }

      it("flushes the outgoing session's work once, then starts the new one clean", async () => {
        saveDraftApi.mockResolvedValue({ id: "draft-alpha" });
        const first = renderHook(() => useComposer(draftFor("Alpha")), { wrapper });

        act(() => {
          first.result.current.setField("bodyHtml", "<p>half-written reply to Alpha</p>");
        });
        // Torn down before the debounce fires, exactly as a compose-param
        // change would tear it down.
        first.unmount();

        expect(saveDraftApi).toHaveBeenCalledTimes(1);
        expect(saveDraftApi).toHaveBeenCalledWith(
          expect.objectContaining({ subject: "Alpha", originalDraftId: undefined }),
        );

        const second = renderHook(() => useComposer(draftFor("Beta")), { wrapper });
        expect(second.result.current.state.draft.subject).toBe("Beta");
        expect(second.result.current.state.draft.bodyHtml).toBe("");
        // Nothing about the new session is dirty yet, so the debounce must not
        // fire a save for content it never authored.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();
        expect(saveDraftApi).toHaveBeenCalledTimes(1);
      });

      // The duplication hazard: the id an autosave advanced to belongs to the
      // session that created it. A remounted composer editing a DIFFERENT
      // message must not send that id as originalDraftId, or its first save
      // would overwrite the previous message's draft instead of creating one.
      it("does not carry the previous session's owned draft id into the new one", async () => {
        saveDraftApi.mockResolvedValue({ id: "draft-alpha" });
        const first = renderHook(() => useComposer(draftFor("Alpha")), { wrapper });

        act(() => {
          first.result.current.setField("bodyHtml", "<p>Alpha body</p>");
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();
        expect(saveDraftApi).toHaveBeenCalledTimes(1);
        first.unmount();

        saveDraftApi.mockResolvedValue({ id: "draft-beta" });
        const second = renderHook(() => useComposer(draftFor("Beta")), { wrapper });
        act(() => {
          second.result.current.setField("bodyHtml", "<p>Beta body</p>");
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(saveDraftApi).toHaveBeenCalledTimes(2);
        expect(saveDraftApi).toHaveBeenLastCalledWith(
          expect.objectContaining({ subject: "Beta", originalDraftId: undefined }),
        );
      });

      // The mirror case: reopening an EXISTING draft must still supersede that
      // draft rather than fork a copy — the remount reseeds the owned id from
      // the new `initial`, it does not clear it.
      it("adopts the new session's own originalDraftId when one is reopened", async () => {
        saveDraftApi.mockResolvedValue({ id: "draft-x" });
        const { result } = renderHook(() => useComposer(draftFor("Reopened", "draft-x")), { wrapper });

        act(() => {
          result.current.setField("bodyHtml", "<p>edited</p>");
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(saveDraftApi).toHaveBeenCalledWith(
          expect.objectContaining({ originalDraftId: "draft-x" }),
        );
      });

      // A remount must not resurrect a message that was already sent: the
      // outgoing instance finalized itself, and the flush has to respect that
      // even though the teardown now comes from a key change rather than a
      // deliberate close.
      it("does not flush a sent message on the teardown that follows the send", async () => {
        sendEmail.mockResolvedValueOnce({ id: "sent-1" });
        const { result, unmount } = renderHook(
          () => useComposer({ ...draftFor("Sent one"), to: [{ name: null, email: "b@example.com" }] }),
          { wrapper },
        );

        await act(async () => {
          await result.current.send();
        });
        unmount();

        expect(saveDraftApi).not.toHaveBeenCalled();
      });
    });
  });
});
