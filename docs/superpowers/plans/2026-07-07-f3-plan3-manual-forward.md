# F3 Plan 3/3 — Manual Forward + F3 Closure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Forward" action on an email in the reader that opens the composer with empty recipients, a single `Fwd:` subject prefix, the sanitized quoted original body, and the original attachments reattached by REUSING their JMAP blobIds (no re-upload). Then mark F3 complete.

**Architecture:** Mirror of the existing reply flow: a pure `forwardDraft()` builder in `composer/reply.ts`, a third button in `ThreadView` that sets `compose=forward:<emailId>` in the URL, and a new branch in `MailPage.resolveComposeDraft`. The only structural addition: `ComposerDraft` gains an optional `attachments` field and `useComposer.initState` seeds `state.attachments` from it — from there the existing composer UI (attachment list, remove buttons) and send path (`{ blobId, name, type }` into `SendEmailInput`) work unchanged. See design §4 in `docs/superpowers/specs/2026-07-07-phase3-sieve-filters-design.md`.

**Tech Stack:** existing — React, TanStack Query, i18next, Zod, Vitest. No new dependencies. No server changes.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys (es neutral default / en fallback); conventional commits; no AI attribution; no compiled `.js` committed.
- TDD per task: failing test first (capture output), implement, pass; both outputs in the report.
- **The forwarded body MUST pass through `sanitizeEmailHtml` (the same call `quotedBody` already makes)** — never embed raw original HTML.
- **Forward is a deliberate per-email action.** No auto-forward, no `redirect` — nothing in this plan touches Sieve.
- Attachments are reattached by blobId only — never re-uploaded, never fetched into the browser. `AttachmentMeta.name` is nullable: apply the `?? "attachment"` fallback before it enters the composer (`sendAttachmentSchema` requires `name.min(1)`).
- Recipients start EMPTY (the existing composer already blocks sending with zero recipients).
- `apps/server` is NOT touched.
- NEVER kill processes globally; every task runs `bun run typecheck` (apps/web) and its tests before committing.
- Branch: `init-manual-forward`.

---

### Task 1: `forwardDraft` builder + attachment seeding

**Files:**
- Modify: `apps/web/src/features/composer/reply.ts` (add `DraftAttachment`, `attachments?` on `ComposerDraft`, `deriveForwardSubject`, `forwardDraft`)
- Modify: `apps/web/src/features/composer/useComposer.ts` (seed `attachments` in `initState`)
- Test: `apps/web/src/features/composer/reply.test.ts` (add a `forwardDraft` describe block)

**Interfaces (produces — Task 2 relies on these):**
- `export type DraftAttachment = { blobId: string; name: string; type: string; size: number }`
- `ComposerDraft` gains `attachments?: DraftAttachment[]`
- `export function forwardDraft(email: EmailDetail, identities: Identity[]): ComposerDraft`

- [ ] **Step 1: Write the failing tests** — append to `apps/web/src/features/composer/reply.test.ts` (reuse the file's existing `identities` and `makeEmail` fixtures; add `forwardDraft` to the import from `./reply`):

```ts
describe("forwardDraft", () => {
  it("prefixes the subject with a single Fwd:", () => {
    expect(forwardDraft(makeEmail(), identities).subject).toBe("Fwd: Meeting notes");
  });

  it("does not double-prefix an already-Fwd: subject", () => {
    const email = makeEmail({ subject: "FWD: Meeting notes" });
    expect(forwardDraft(email, identities).subject).toBe("FWD: Meeting notes");
  });

  it("starts with no recipients", () => {
    const draft = forwardDraft(makeEmail(), identities);
    expect(draft.to).toEqual([]);
    expect(draft.cc).toEqual([]);
    expect(draft.bcc).toEqual([]);
  });

  it("quotes the sanitized original body with attribution", () => {
    const draft = forwardDraft(makeEmail(), identities);
    expect(draft.bodyHtml).toContain("Hello");
    expect(draft.bodyHtml).toContain("<blockquote>");
    expect(draft.bodyHtml).toContain("2024-01-01T00:00:00Z");
    expect(draft.bodyHtml).toContain("Bob");
    expect(draft.bodyHtml).not.toMatch(/src=["']https?:\/\//i);
  });

  it("reuses the original attachments by blobId with a name fallback", () => {
    const email = makeEmail({
      attachments: [
        { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048 },
        { blobId: "b2", name: null, type: "image/png", size: 512 },
      ],
    });
    const draft = forwardDraft(email, identities);
    expect(draft.attachments).toEqual([
      { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048 },
      { blobId: "b2", name: "attachment", type: "image/png", size: 512 },
    ]);
  });

  it("picks the identity that received the original", () => {
    expect(forwardDraft(makeEmail(), identities).identityId).toBe("id1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/features/composer/reply.test.ts`
Expected: FAIL — `forwardDraft` is not exported.

- [ ] **Step 3: Implement** — in `apps/web/src/features/composer/reply.ts`:

Add the type and extend `ComposerDraft` (keep every existing field and comment):

```ts
export type DraftAttachment = { blobId: string; name: string; type: string; size: number };
```

```ts
  // present only on forward drafts: original attachments reattached by blobId
  attachments?: DraftAttachment[];
```

Add below `deriveSubject`:

```ts
function deriveForwardSubject(subject: string): string {
  return /^fwd:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}
```

Add at the end of the file:

```ts
export function forwardDraft(email: EmailDetail, identities: Identity[]): ComposerDraft {
  const identity = pickIdentity(email, identities);
  return {
    identityId: identity?.id ?? identities[0]?.id ?? "",
    to: [],
    cc: [],
    bcc: [],
    subject: deriveForwardSubject(email.subject),
    bodyHtml: quotedBody(email),
    attachments: email.attachments.map((attachment) => ({
      blobId: attachment.blobId,
      name: attachment.name ?? "attachment",
      type: attachment.type,
      size: attachment.size,
    })),
  };
}
```

In `apps/web/src/features/composer/useComposer.ts`, change `initState` to seed from the draft (structural match with the local `Attachment` type — no new import needed):

```ts
function initState(draft: ComposerDraft): ComposerState {
  return {
    draft,
    attachments: draft.attachments ?? [],
    uploads: [],
    sending: false,
    sendError: null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- src/features/composer/reply.test.ts`
Expected: PASS (existing reply tests + 6 new forward tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/composer/reply.ts apps/web/src/features/composer/useComposer.ts apps/web/src/features/composer/reply.test.ts
git commit -m "feat(web): forward draft builder reusing attachment blob ids"
```

---

### Task 2: Forward button + composer wiring + i18n

**Files:**
- Modify: `apps/web/src/features/reader/ThreadView.tsx` (Forward button next to Reply/Reply all)
- Modify: `apps/web/src/features/mailbox/MailPage.tsx` (compose-param parsing + `resolveComposeDraft` forward branch)
- Modify: `apps/web/src/app/locales/en.json`, `apps/web/src/app/locales/es.json` (add `composer.forward`)
- Test: `apps/web/src/features/composer/wiring.test.tsx` (forward case), `apps/web/src/features/reader/thread-view.test.tsx` (button presence)

**Interfaces:**
- Consumes: `forwardDraft` (Task 1).
- Produces: URL contract `compose=forward:<emailId>` handled end to end.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/app/locales/*.json` the key does not exist yet, so add it FIRST so tests can reference it (this is part of this task's red-green cycle): in `composer`, right after `"replyAll"`:

- en.json: `"forward": "Forward",`
- es.json: `"forward": "Reenviar",`

In `apps/web/src/features/reader/thread-view.test.tsx`, add (mirroring the file's existing render helper and fixtures — read the file first; the thread fixture's last email is the one that gets action buttons):

```tsx
  it("renders a Forward button for the last email", async () => {
    // reuse the file's existing render/setup for a loaded thread
    expect(
      await screen.findByRole("button", { name: i18n.t("composer.forward") }),
    ).toBeInTheDocument();
  });
```

(If the file does not already import `i18n`, import it the same way sibling tests do. If existing tests don't render the buttons region, mirror whatever setup makes the Reply buttons visible — they render for the last email of the loaded thread.)

In `apps/web/src/features/composer/wiring.test.tsx`, add a forward case. Read the file's `stubFetch` fixture first; extend the stubbed thread email `e1` with one attachment `{ blobId: "b1", name: "doc.pdf", type: "application/pdf", size: 2048 }` if it has none (additive — existing tests don't assert attachment absence; if any does, use a per-test stub instead). Then:

```tsx
  it("opens the composer at compose=forward:e1 with Fwd subject, no recipients and the original attachment", async () => {
    stubFetch();
    renderAt("/?mailbox=mb1&thread=t1&compose=forward:e1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.title") });
    const subject = within(dialog).getByLabelText(i18n.t("composer.subject"));
    expect((subject as HTMLInputElement).value).toMatch(/^Fwd: /);
    expect(within(dialog).getByText(/doc\.pdf/)).toBeInTheDocument();
    expect(within(dialog).queryByText("a@x.com")).not.toBeInTheDocument();
  });
```

(Adapt the subject-field query to how the composer labels its subject input — check `Composer.tsx`; adapt `"a@x.com"` to whatever from-address the stub uses in the existing reply test, asserting that address does NOT appear as a recipient chip in the forward case.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/features/reader/thread-view.test.tsx src/features/composer/wiring.test.tsx`
Expected: FAIL — no Forward button; forward param unhandled (composer opens empty or not at all).

- [ ] **Step 3: Implement**

In `apps/web/src/features/reader/ThreadView.tsx`, add a third button after Reply all (same classes):

```tsx
                <button
                  type="button"
                  onClick={() => openCompose(`forward:${email.id}`)}
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  {t("composer.forward")}
                </button>
```

In `apps/web/src/features/mailbox/MailPage.tsx`:

1. Import `forwardDraft` alongside `replyDraft` from `../composer/reply`.
2. Replace the reply-only param parsing:

```ts
  const composeParam = searchParams.get("compose");
  const groupParam = searchParams.get("group");
  const composeMatch = composeParam?.match(/^(reply|reply-all|forward):(.+)$/) ?? null;
  const composeMode = composeMatch?.[1];
  const composeEmailId = composeMatch?.[2];
```

3. Update the thread query gate to use the new match: `enabled: Boolean(composeMatch) && Boolean(threadParam)`.
4. Update `resolveComposeDraft`'s branch (keep the structure; only the tail changes):

```ts
    if (composeParam === "new") return emptyDraft(identities);
    if (!composeMatch) return null;
    if (composeThreadQuery.isLoading) return null;

    const email = composeThreadQuery.data?.emails.find(
      (candidate) => candidate.id === composeEmailId,
    );
    if (!email) return emptyDraft(identities);
    if (composeMode === "forward") return forwardDraft(email, identities);
    return replyDraft(email, identities, composeMode === "reply-all");
```

5. Remove the now-unused `replyMatch`/`replyAll`/`replyEmailId` bindings (they are replaced by the three above — search the file for other usages first and update them to the new names).

- [ ] **Step 4: Run tests to verify they pass, plus the FULL web suite**

Run: `cd apps/web && bun run test -- src/features/reader/thread-view.test.tsx src/features/composer/wiring.test.tsx`
Expected: PASS.
Run: `cd apps/web && bun run test`
Expected: PASS — no regressions (especially the existing reply wiring tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/reader/ThreadView.tsx apps/web/src/features/mailbox/MailPage.tsx apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json apps/web/src/features/composer/wiring.test.tsx apps/web/src/features/reader/thread-view.test.tsx
git commit -m "feat(web): forward action in reader wired to the composer"
```

---

### Task 3: F3 closure + verification sweep

**Files:**
- Modify: `docs/ARCHITECTURE.md` (mark F3 complete)

- [ ] **Step 1: Mark F3 complete** — in `docs/ARCHITECTURE.md`, find the F3 phase entry (Fase 3 / F3: filtros Sieve + respuestas automáticas) and mark it complete EXACTLY the way F1 and F2 entries are marked (they read `✅ Completa`); do not reword anything else. The doc is in Spanish — keep it that way.

- [ ] **Step 2: Full verification**

Run, capturing tails:
- `cd apps/web && bun run test` — PASS.
- `cd apps/server && bun run test` — PASS (untouched; regression guard).
- `cd apps/web && bun run typecheck` && `cd packages/shared && bun run typecheck` — clean.
- `cd apps/web && bun run build` — vite build succeeds.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: mark phase 3 complete in architecture"
```
