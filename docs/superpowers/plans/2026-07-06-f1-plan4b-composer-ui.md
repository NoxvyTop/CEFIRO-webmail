# F1 Plan 4b/4 — Composer UI (compose, reply, signatures, attachments)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees write and send mail: a rich-text composer (TipTap) opened blank, as a reply, or reply-all — with a send-as identity picker, signature insertion, attachment upload with progress, and send. Plus a settings screen to manage signatures. Completes Phase 1 end-to-end.

**Architecture:** Composer is a modal over the mail layout, its state (recipients, subject, body, attachments) owned by a `useComposer` hook. It calls the Plan 4a endpoints via a compose API client validated by `@webmail/shared`. Reply/reply-all prefill derives recipients, subject, quoted body and threading headers from the currently open `EmailDetail`. URL param `compose` opens it (`new` | `reply:<emailId>` | `reply-all:<emailId>`). See `docs/ARCHITECTURE.md`.

**Tech Stack:** existing web stack + `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link` (^2.10).

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys, es (neutral Spanish) default / en fallback; conventional commits; no AI attribution; no compiled .js committed.
- TDD per task: failing output captured, then passing; both in the report.
- Zero runtime internet: TipTap from npm at build, no CDNs.
- Security: composer HTML is user-authored (safe to send); any quoted incoming HTML re-inserted into a reply MUST pass through the existing `sanitizeEmailHtml` first. Never render remote content in the composer.
- `bunx vitest run` in apps/web (jsdom); TipTap needs no real layout but its editor may need `{ immediatelyRender: false }` in tests — the component exposes a `readOnlyFallback`/plain-textarea path via a `testMode` prop where the editor can't mount, OR mount TipTap normally if jsdom supports it (prefer real mount; fall back only if it fails).
- Run `bun install` from REPO ROOT for deps (commit bun.lock).
- NEVER kill processes globally.
- Branch: `init-composer-ui`.

---

### Task 1: Compose API client + reply derivation

**Files:**
- Create: `apps/web/src/features/composer/api.ts`, `apps/web/src/features/composer/reply.ts`
- Modify: `apps/web/package.json` (add the three TipTap deps — installed here for Task 3)
- Test: `apps/web/src/features/composer/api.test.ts`, `apps/web/src/features/composer/reply.test.ts`

**Interfaces (produces):**

`api.ts`:

```ts
import {
  blobUploadResultSchema, identitySchema, sendEmailSchema, signatureSchema,
  signatureInputSchema,
  type BlobUploadResult, type Identity, type SendEmailInput, type Signature, type SignatureInput,
} from "@webmail/shared";
import { z } from "zod";
import { MailApiError } from "../mailbox/api";

// parseError reused pattern from mailbox/api.ts (throw MailApiError)
export async function fetchIdentities(): Promise<Identity[]>;          // GET /api/mail/identities
export async function fetchSignatures(): Promise<Signature[]>;        // GET /api/mail/signatures
export async function createSignature(input: SignatureInput): Promise<Signature>;   // POST
export async function updateSignature(id: string, input: SignatureInput): Promise<Signature>; // PUT
export async function deleteSignature(id: string): Promise<void>;     // DELETE
export async function uploadAttachment(file: File, onProgress?: (fraction: number) => void): Promise<BlobUploadResult>;
export async function sendEmail(input: SendEmailInput): Promise<void>; // POST /api/mail/send
```

- `uploadAttachment` uses `XMLHttpRequest` (fetch has no upload progress): POST `/api/mail/blobs`, `content-type` = `file.type || "application/octet-stream"`, body the `File`; `upload.onprogress` → `onProgress(e.loaded / e.total)`; on load parse with `blobUploadResultSchema`; non-2xx → `MailApiError`. Resolve/reject a Promise.
- All others: `fetch` + `MailApiError` on non-ok + schema validation.

`reply.ts`:

```ts
import { sanitizeEmailHtml } from "../reader/sanitize";
import type { EmailDetail, EmailAddress, Identity } from "@webmail/shared";

export type ComposerDraft = {
  identityId: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  inReplyTo?: string[];
  references?: string[];
};

export function emptyDraft(identities: Identity[]): ComposerDraft;
export function replyDraft(email: EmailDetail, identities: Identity[], all: boolean): ComposerDraft;
```

Derivation rules:
- `emptyDraft`: identityId = first identity id (or ""), all recipient arrays empty, subject "", bodyHtml "".
- `replyDraft`:
  - `to` = `email.replyTo.length ? email.replyTo : email.from`.
  - `cc` = all=false → []; all=true → `email.to ∪ email.cc` MINUS any address equal (case-insensitive email) to the chosen identity's email and minus addresses already in `to`. De-dup by lowercased email.
  - identityId: pick the identity whose email matches (case-insensitive) any address in the original `email.to`/`email.cc`; fallback to first identity.
  - `subject`: original subject with a single `Re: ` prefix (don't double-prefix if it already starts with `re:` case-insensitive).
  - `bodyHtml`: `<br><br>` + a quoted block: `<blockquote>` containing sanitized original (`sanitizeEmailHtml(email.bodyHtml ?? escaped(email.bodyText ?? ""), { allowRemoteImages: false }).html`). Prepend an attribution line `<p>{date} — {fromName/email}:</p>` (plain text, escaped).
  - `inReplyTo`: `[email.id]`? NO — JMAP threading uses Message-IDs, which we don't expose; set `inReplyTo`/`references` to `undefined` for F1 (threading by JMAP threadId is server-side; document this limitation). Keep the fields in the type for Plan-later use.

- [ ] **Step 1: Failing tests.**
  - `api.test.ts`: fetchIdentities validates + MailApiError on 503; sendEmail POSTs body; createSignature POSTs input; uploadAttachment (stub `XMLHttpRequest` with a minimal fake exposing `upload`, `open`, `send`, `setRequestHeader`, `status`, `responseText`, and letting the test drive `onload`) resolves a BlobUploadResult and calls onProgress.
  - `reply.test.ts`: emptyDraft picks first identity; replyDraft to=replyTo-or-from; reply-all cc excludes own identity + dedups; subject single Re:; already-Re: not doubled; quoted body contains sanitized content and NOT a remote image from the original; identity chosen by matching original recipient.
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Add deps, `bun install` from root, implement.**
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add compose api client and reply derivation`

---

### Task 2: useComposer hook

**Files:**
- Create: `apps/web/src/features/composer/useComposer.ts`
- Test: `apps/web/src/features/composer/use-composer.test.ts`

**Interface (produces):**

```ts
export type Attachment = { blobId: string; name: string; type: string; size: number };
export type PendingUpload = { id: string; name: string; progress: number; error: boolean };

export type ComposerState = {
  draft: ComposerDraft;
  attachments: Attachment[];
  uploads: PendingUpload[];
  sending: boolean;
  sendError: string | null;
};

export function useComposer(initial: ComposerDraft): {
  state: ComposerState;
  setField<K extends keyof ComposerDraft>(key: K, value: ComposerDraft[K]): void;
  addFiles(files: File[]): void;      // uploads each, tracking progress; on success moves to attachments
  removeAttachment(blobId: string): void;
  send(): Promise<boolean>;           // validates recipients; returns true on success
};
```

Rules:
- `addFiles`: for each file create a PendingUpload (random id, progress 0), call `uploadAttachment(file, p => update progress)`, on success push to `attachments` and drop the pending entry, on error mark the pending entry `error: true` (keep it visible for retry/remove — removal via a pending id variant of removeAttachment is out of scope; just mark error).
- `send`: builds `SendEmailInput` from draft + attachments (map to `{blobId,name,type}`); requires at least one recipient across to/cc/bcc else sets `sendError = "composer.errors.noRecipients"` and returns false; sets `sending`, calls `sendEmail`, on `MailApiError` sets `sendError = "composer.errors." + code fallback generic`, returns false; success returns true.
- Pure state via `useReducer` (deterministic, testable). Uploads use the real `uploadAttachment` — tests stub the module.

- [ ] **Step 1: Failing test** — mock `./api` (`vi.mock`): addFiles success path moves to attachments and clears pending; addFiles error path marks error; send with no recipients → false + noRecipients error and does NOT call sendEmail; send happy path calls sendEmail with mapped input and returns true; send MailApiError → false + mapped error key. (Render the hook with `@testing-library/react`'s `renderHook`.)
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add composer state hook with attachment uploads`

---

### Task 3: Composer modal (TipTap editor, recipients, identity, attachments, send)

**Files:**
- Create: `apps/web/src/features/composer/Composer.tsx`, `apps/web/src/features/composer/RichTextEditor.tsx`, `apps/web/src/features/composer/RecipientField.tsx`
- Modify: locales
- Test: `apps/web/src/features/composer/composer.test.tsx`

**Contract:**
- `RichTextEditor` props `{ html: string; onChange(html: string): void; ariaLabel: string }`: TipTap `useEditor` with StarterKit + Link, `content=html`, `onUpdate` → `onChange(editor.getHTML())`, `immediatelyRender: false`. A minimal toolbar: bold, italic, bullet list, link (prompt for URL via a controlled small input, not `window.prompt`). Editor container has `role="textbox"` `aria-label`.
- `RecipientField` props `{ label; value: EmailAddress[]; onChange(v: EmailAddress[]): void }`: a text input where typing an email + Enter/comma adds `{name:null,email}` (basic email shape check — contains `@`; invalid shows an inline hint, doesn't add); each recipient a removable chip; `aria-label` = label.
- `Composer` props `{ initial: ComposerDraft; onClose(): void }`: uses `useComposer`. Layout (modal `role="dialog"` `aria-label={t("composer.title")}`): identity `<select>` (from `useQuery` identities; label t("composer.from")), To/Cc/Bcc RecipientFields (Cc/Bcc behind a "add Cc/Bcc" toggle), subject input, a signature `<select>` (from signatures query; choosing one appends its `contentHtml` to the body once — insert `<br>—<br>` + signature), RichTextEditor, attachment area (file input → `addFiles`; list of attachments with name + size + remove; pending uploads show a progress bar and error state), and a footer: Send button (disabled while `sending`), Cancel (`onClose`). On successful `send()` → call `onClose`. `sendError` renders an alert with `t(sendError)`.
- i18n keys (es/en): `composer.title` "Redactar"/"Compose", `composer.from` "De"/"From", `composer.to` "Para"/"To", `composer.cc` "Cc"/"Cc", `composer.bcc` "Cco"/"Bcc", `composer.addCcBcc` "Cc/Cco"/"Cc/Bcc", `composer.subject` "Asunto"/"Subject", `composer.body` "Mensaje"/"Message", `composer.signature` "Firma"/"Signature", `composer.attach` "Adjuntar"/"Attach", `composer.send` "Enviar"/"Send", `composer.cancel` "Cancelar"/"Cancel", `composer.sending` "Enviando…"/"Sending…", `composer.invalidEmail` "Correo inválido"/"Invalid email", `composer.errors.noRecipients` "Agrega al menos un destinatario"/"Add at least one recipient", `composer.errors.invalid_identity` "Identidad inválida"/"Invalid identity", `composer.errors.send_failed` "No se pudo enviar"/"Could not send", `composer.errors.generic` "Ocurrió un error"/"Something went wrong", `composer.bold`/`italic`/`bulletList`/`link` toolbar labels, `composer.linkUrl` "URL del enlace"/"Link URL".
- If TipTap fails to mount under jsdom, `RichTextEditor` must still render an accessible `role="textbox"` element the test can type into and that calls `onChange` — implement a `contentEditable` fallback only if the real editor throws; keep the interface identical.

- [ ] **Step 1: Failing test** — render Composer with stubbed identities (2) + signatures (1) queries and a mocked useComposer OR real hook with mocked api. Assert: dialog with From select showing identities; typing a recipient in To + Enter adds a chip; typing body via the editor textbox updates; clicking Send with no recipient shows noRecipients alert; with a recipient, Send calls the send path and then onClose. (Mock `./api` for identities/signatures/send; use `virtualized`-free simple render.)
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add composer modal with rich text editor and attachments`

---

### Task 4: Wire composer into the app (compose/reply/reply-all)

**Files:**
- Modify: `apps/web/src/features/mailbox/MailPage.tsx` (compose URL param + open logic), `apps/web/src/app/App.tsx` (Compose button in header), `apps/web/src/features/reader/ThreadView.tsx` (Reply / Reply all buttons)
- Test: `apps/web/src/features/composer/wiring.test.tsx`

**Contract:**
- URL param `compose`: `new` | `reply:<emailId>` | `reply-all:<emailId>`. MailPage reads it; when set, resolves the initial draft:
  - `new` → `emptyDraft(identities)`.
  - `reply:<id>` / `reply-all:<id>` → find the email in the currently loaded thread query cache (the reader is open on that thread); if not resolvable, fall back to `emptyDraft`. Build via `replyDraft(email, identities, all)`.
  - Renders `<Composer initial={draft} onClose={() => removeComposeParam()} />`. Needs identities loaded first (query); while loading, no modal.
- Header "Compose" button (`t("composer.title")`) sets `compose=new`.
- ThreadView gains Reply (`t("composer.reply")` "Responder"/"Reply") and Reply-all (`t("composer.replyAll")` "Responder a todos"/"Reply all") buttons per the LAST email of the thread, setting `compose=reply:<lastEmailId>` / `reply-all:<lastEmailId>`.
- Add keys `composer.reply`, `composer.replyAll`.

- [ ] **Step 1: Failing test** — render app at `/?mailbox=mb1&thread=t1&compose=new` with stubbed queries (identities, mailboxes, messages, thread); assert the composer dialog opens; closing it (Cancel) removes the param (dialog gone). Second case: `compose=reply:e1` with a thread whose last email e1 has from `a@x.com` → composer opens with `a@x.com` chip in To. (Stub fetches per URL.)
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): wire composer for new, reply and reply-all`

---

### Task 5: Signature settings screen + attachment download wiring

**Files:**
- Create: `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/settings/SignatureSettings.tsx`
- Modify: `apps/web/src/app/routes.tsx` (add `/settings` under RequireAuth), `apps/web/src/app/App.tsx` (settings link), `apps/web/src/features/reader/ThreadView.tsx` (attachment chips become download links), locales
- Test: `apps/web/src/features/settings/signature-settings.test.tsx`

**Contract:**
- `SignatureSettings`: lists signatures (query), each with name, a default badge, edit and delete buttons; a form (name input + RichTextEditor for contentHtml + "default" checkbox) to create; edit loads into the form; save calls create/update; delete calls deleteSignature; all invalidate `["mail","signatures"]`. Uses the compose api client.
- `SettingsPage`: `role="main"`, heading `t("settings.title")` ("Ajustes"/"Settings"), renders SignatureSettings under a section `t("settings.signatures")` ("Firmas"/"Signatures"). A back link to `/`.
- Route `/settings` wrapped in RequireAuth; header gets a settings link/button (`t("settings.title")`).
- ThreadView attachment chips: turn each into an `<a>` with `href` = `/api/mail/blobs/${blobId}?name=${enc}&type=${enc}&dl=1` (download) and, for previewable types (pdf/image per the server allowlist), a second "view" link without `dl` (opens inline in a new tab). Remove the "download coming soon" title. Add keys `attachments.download` "Descargar"/"Download", `attachments.view` "Ver"/"View".
- i18n keys: `settings.title`, `settings.signatures`, `settings.back` "Volver"/"Back", `settings.newSignature` "Nueva firma"/"New signature", `settings.name` "Nombre"/"Name", `settings.default` "Predeterminada"/"Default", `settings.save` "Guardar"/"Save", `settings.delete` "Eliminar"/"Delete", `settings.edit` "Editar"/"Edit".

- [ ] **Step 1: Failing test** — `signature-settings.test.tsx`: render SignatureSettings with stubbed signatures list (one default); assert it lists the signature with a default badge; fill the create form (name + body) and submit → assert a POST to `/api/mail/signatures` with the input; delete → DELETE call. (Mock `../composer/api` or fetch per URL.)
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add signature settings and attachment download links`

---

### Task 6: Verification + Phase 1 end-to-end sweep

**Files:** none new — verification and docs.

- [ ] **Step 1:** `bun run typecheck` (root) and `bun run test` (root; Postgres 5434 up) — all green.
- [ ] **Step 2:** Dev container: recreate `dev`, poll health, `curl -s http://localhost:5173 → 200`, `docker compose logs dev | tail` shows no build errors. Confirm the SPA bundle builds with TipTap (no CDN, egress rule holds) via `docker compose -f docker-compose.dev.yml exec dev sh -c "cd apps/web && bunx vite build"` → succeeds.
- [ ] **Step 3:** Update `docs/ARCHITECTURE.md` "Fases de entrega": mark F1 done (add a note that F1 mail core is complete: read + compose/reply + signatures + labels + notifications + attachments + SSO + bootstrap). Keep it one or two lines.
- [ ] **Step 4:** Commit any doc/fix — `docs: mark phase 1 mail core complete` (or a fix commit if Step 1/2 surfaced anything).

---

## Out of Scope (Phase 2+)

- Drafts autosave and a Drafts folder editing flow; scheduled send.
- Contacts/address-book autocomplete in RecipientField (F1 uses free-typed addresses).
- Admin portal (F2), mail groups (F2), Sieve filters (F3), Odoo modules (F4).
- Message-ID-based threading headers on reply (needs server to expose Message-ID; JMAP threadId handles grouping server-side for now).
