import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EmailDetail, Identity } from "@webmail/shared";
import { buildEditDraft, type ComposerDraft } from "./reply";
import { applySignature, SIGNATURE_MARKER_ATTR, type SignatureContent } from "./signature";
import { useComposer } from "./useComposer";

const { saveDraftApi } = vi.hoisted(() => ({ saveDraftApi: vi.fn() }));

vi.mock("./api", () => ({
  uploadAttachment: vi.fn(),
  sendEmail: vi.fn(),
  saveDraft: saveDraftApi,
}));
vi.mock("./aiApi", () => ({ fetchAiDraft: vi.fn() }));

const identities: Identity[] = [{ id: "id1", name: "Alice", email: "alice@example.com" }];

function makeEmail(overrides: Partial<EmailDetail> = {}): EmailDetail {
  return {
    id: "draft-1",
    threadId: "t1",
    mailboxIds: ["drafts"],
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [],
    cc: [],
    replyTo: [],
    subject: "Hi",
    receivedAt: "2024-01-01T00:00:00Z",
    preview: "",
    keywords: {},
    hasAttachment: false,
    size: 10,
    bodyHtml: "",
    bodyText: null,
    attachments: [],
    messageId: null,
    references: null,
    inReplyTo: null,
    senderAuth: "unknown",
    bodyTruncated: false,
    ...overrides,
  };
}

function draftWith(bodyHtml: string): ComposerDraft {
  return {
    identityId: "id1",
    to: [],
    cc: [],
    bcc: [],
    subject: "Hi",
    bodyHtml,
    originalDraftId: "draft-1",
  };
}

// GH #156: reopening a saved draft duplicated the signature on every
// save -> reopen -> auto-apply cycle. The chain, as filed:
//   1. useComposer.ts's buildComposePayload stripped the internal
//      SIGNATURE_MARKER_ATTR wrapper before persisting a draft -- the same
//      stripping an actual outgoing send needs, applied one step too early.
//   2. reply.ts's buildEditDraft (reopening the draft) got that already-
//      unmarked HTML back verbatim.
//   3. Composer.tsx's default-signature auto-apply effect ran again on open,
//      not distinguishing a reopened draft from a brand new message.
//   4. signature.ts's applySignature found no existing marker (it was
//      stripped in step 1) and appended a second, unmarked copy instead of
//      replacing the first -- one more copy every reopen.
//
// This test drives the real production seams for each of those four steps
// (useComposer's saveDraft(), reply.ts's buildEditDraft, and signature.ts's
// applySignature) through several full cycles and asserts the invariant:
// a composer body never contains more than one signature block, no matter
// how many save/reopen/apply cycles it goes through.
describe("signature persistence across save/reopen cycles (GH #156)", () => {
  it("never accumulates more than one signature block across repeated save -> reopen -> auto-apply cycles", async () => {
    saveDraftApi.mockResolvedValue({ id: "draft-1" });
    const signature: SignatureContent = { contentHtml: "<p>Thanks, Alice</p>" };

    // 1. New compose: the default signature is auto-applied once, on open
    //    (mirrors Composer.tsx's appliedDefaultRef effect).
    let bodyHtml = applySignature("", signature);

    for (let cycle = 0; cycle < 3; cycle++) {
      // 2. Save as a draft through the real useComposer hook -- this is what
      //    actually gets sent to the server.
      const { result } = renderHook(() => useComposer(draftWith(bodyHtml)));
      await act(async () => {
        await result.current.saveDraft();
      });
      const persistedHtml = saveDraftApi.mock.calls.at(-1)?.[0]?.htmlBody as string;

      // 3. Reopen: reply.ts's buildEditDraft is the real code path that
      //    turns a fetched draft email back into a ComposerDraft.
      const reopened = buildEditDraft(makeEmail({ bodyHtml: persistedHtml }), identities);

      // 4. Auto-apply runs again on open, applying the same default signature.
      bodyHtml = applySignature(reopened.bodyHtml, signature);
    }

    const markerMatches = bodyHtml.match(new RegExp(SIGNATURE_MARKER_ATTR, "g")) ?? [];
    expect(markerMatches).toHaveLength(1);
    const textMatches = bodyHtml.match(/Thanks, Alice/g) ?? [];
    expect(textMatches).toHaveLength(1);
  });

  it("keeps a single signature block when the user switches signatures on a reopened draft", async () => {
    saveDraftApi.mockResolvedValue({ id: "draft-1" });
    const signatureA: SignatureContent = { contentHtml: "<p>Signature A</p>" };
    const signatureB: SignatureContent = { contentHtml: "<p>Signature B</p>" };

    // Open, auto-apply default signature A, save.
    const applied = applySignature("<p>Hello</p>", signatureA);
    const { result } = renderHook(() => useComposer(draftWith(applied)));
    await act(async () => {
      await result.current.saveDraft();
    });
    const persistedHtml = saveDraftApi.mock.calls.at(-1)?.[0]?.htmlBody as string;

    // Reopen the draft and manually switch to a different signature (this is
    // handleSignatureChange in Composer.tsx, driven by the same applySignature
    // pure function).
    const reopened = buildEditDraft(makeEmail({ bodyHtml: persistedHtml }), identities);
    const switched = applySignature(reopened.bodyHtml, signatureB);

    const markerMatches = switched.match(new RegExp(SIGNATURE_MARKER_ATTR, "g")) ?? [];
    expect(markerMatches).toHaveLength(1);
    expect(switched).not.toContain("Signature A");
    expect((switched.match(/Signature B/g) ?? []).length).toBe(1);
  });
});
