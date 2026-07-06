# F1 Plan 4a/4 — Compose API (identities, signatures, attachments, send)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The BFF can list a user's sending identities, manage their signatures, stream attachment blobs up to and down from Stalwart (with Range support), and send email via JMAP EmailSubmission — everything the Plan 4b composer UI needs.

**Architecture:** Same patterns as Plan 3a: typed endpoints over the existing mail router/context, stubbed JMAP client in tests, credentials only in Basic headers. Sending uses one chained JMAP request: `Email/set` create (bodyValues + attachments by blobId, into Drafts) back-referenced by `EmailSubmission/set` with `onSuccessUpdateEmail` moving the message to Sent. Blob transfers are pure streams through the BFF — nothing buffered, nothing parsed. See `docs/ARCHITECTURE.md`.

**Tech Stack:** existing stack; no new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; conventional commits; no AI attribution; no compiled .js committed.
- TDD per task: failing output captured, then passing; both in the report.
- Runtime-agnostic; mail content and credentials never logged or audited; secrets never in fixtures.
- Postgres integration tests on 5434 (fallback URL as in existing tests); JMAP always stubbed in tests.
- NEVER kill processes globally.
- Branch: `init-compose-api`.

---

### Task 1: Shared compose contracts + JMAP session/upload extensions

**Files:**
- Create: `packages/shared/src/api/compose.ts`; export from `packages/shared/src/index.ts`
- Modify: `apps/server/src/infra/stalwart/jmap.ts` (session upload/download URLs + submission capability)
- Test: `packages/shared/src/api/compose.test.ts`, extend `apps/server/src/infra/stalwart/jmap.test.ts`

**Interfaces (produces):**

`packages/shared/src/api/compose.ts`:

```ts
import { z } from "zod";
import { emailAddressSchema } from "./mail";

export const identitySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
export type Identity = z.infer<typeof identitySchema>;

export const signatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentHtml: z.string(),
  isDefault: z.boolean(),
});
export type Signature = z.infer<typeof signatureSchema>;

export const signatureInputSchema = z.object({
  name: z.string().min(1),
  contentHtml: z.string(),
  isDefault: z.boolean().default(false),
});
export type SignatureInput = z.infer<typeof signatureInputSchema>;

export const blobUploadResultSchema = z.object({
  blobId: z.string(),
  type: z.string(),
  size: z.number(),
});
export type BlobUploadResult = z.infer<typeof blobUploadResultSchema>;

export const sendAttachmentSchema = z.object({
  blobId: z.string(),
  name: z.string().min(1),
  type: z.string().min(1),
});

export const sendEmailSchema = z
  .object({
    identityId: z.string().min(1),
    to: z.array(emailAddressSchema).default([]),
    cc: z.array(emailAddressSchema).default([]),
    bcc: z.array(emailAddressSchema).default([]),
    subject: z.string().default(""),
    textBody: z.string(),
    htmlBody: z.string().optional(),
    attachments: z.array(sendAttachmentSchema).default([]),
    inReplyTo: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length > 0, {
    message: "at least one recipient is required",
  });
export type SendEmailInput = z.infer<typeof sendEmailSchema>;
```

`jmap.ts` changes:
- `JmapSession` gains `uploadUrl: string; downloadUrl: string;` — mapped from the session body (`?? ""` defaults like eventSourceUrl).
- `request()` `using` array becomes `["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"]`.

- [ ] **Step 1: Failing tests.** compose.test.ts: parse a valid Identity, Signature, BlobUploadResult; sendEmailSchema rejects zero recipients and accepts bcc-only; signatureInputSchema defaults isDefault false. jmap.test.ts additions: session test asserts `uploadUrl`/`downloadUrl` mapped from body (add them to `sessionBody`); request test asserts `body.using` contains the submission urn.
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Both packages' suites + typecheck green.**
- [ ] **Step 5: Commit** — `feat(shared): add compose contracts and jmap submission capability`

---

### Task 2: Identities endpoint

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `GET /identities`)
- Test: `apps/server/src/modules/mail/identities.test.ts`

**Contract:** `GET /api/mail/identities` → one call `[["Identity/get", { accountId }, "0"]]` → map list to `Identity[]`: `{ id, name: name ?? "", email }`; entries without `email` are skipped. Standard mail guards apply (session/config/credential — reuse the established scaffolding).

- [ ] **Step 1: Failing test** (scaffolding from mailboxes.test.ts): stub returns two identities (one without name → mapped to "") plus one without email (skipped); assert 200 array of 2 validated with `z.array(identitySchema)`; 401 without session.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add identities endpoint`

---

### Task 3: Signatures repository and CRUD endpoints

**Files:**
- Create: `apps/server/src/infra/repos/signatures.ts`
- Modify: `apps/server/src/modules/mail/router.ts` (signature routes — they only need the session guard, NOT the JMAP context; mount them before `requireMail` or in a sub-router that only applies `requireSession`)
- Test: `apps/server/src/modules/mail/signatures.test.ts`

**Interfaces (produces):**

```ts
export function createSignaturesRepo(sql: Db) {
  return {
    list(userId: string): Promise<Signature[]>;            // ordered: default first, then name
    create(userId: string, input: SignatureInput): Promise<Signature>;
    update(userId: string, id: string, input: SignatureInput): Promise<Signature | null>; // null when not found/not owned
    remove(userId: string, id: string): Promise<boolean>;
  };
}
```

Rules: `isDefault: true` on create/update clears `is_default` on the user's other signatures (single transaction via `sql.begin`). All queries filter by `user_id` (ownership enforced in SQL, never trust the id alone). Column mapping: `content_html` ↔ `contentHtml`, `is_default` ↔ `isDefault`.

**Routes** (session guard only): `GET /api/mail/signatures` → list; `POST` → 200 created (body `signatureInputSchema`, 400 invalid_body incl. malformed JSON); `PUT /api/mail/signatures/:id` → 200 or 404 not_found; `DELETE /api/mail/signatures/:id` → `{ ok: true }` or 404.

**Router restructure note:** `createMailRouter` currently applies `requireSession` + `requireMail` with `router.use("*", ...)`. Restructure minimally: apply `requireSession` on `"*"`, but apply `requireMail` NOT globally — instead group the JMAP-backed routes (`/mailboxes`, `/messages*`, `/threads/*`, `/events`, `/identities`) under `router.use` path patterns or apply `requireMail` per-route as a route-level middleware argument. Signature routes must work with `jmap: null` (no Stalwart configured) — that is the point of the split; add a test asserting signatures work with `jmap: null`.

- [ ] **Step 1: Failing test** — integration (Postgres): CRUD roundtrip for the session user; default-switch behavior (create A default, create B default → A no longer default); ownership (user2's session cannot update/delete user1's signature → 404); works with `jmap: null`; 400 on invalid body.
- [ ] **Step 2: Verify failure.** **Step 3: Implement repo + routes + restructure.** **Step 4: FULL mail suite green (the restructure must not break existing route tests) + typecheck.**
- [ ] **Step 5: Commit** — `feat(server): add signature repository and crud endpoints`

---

### Task 4: Attachment blob upload and download

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `POST /blobs`, `GET /blobs/:blobId`)
- Test: `apps/server/src/modules/mail/blobs.test.ts`

**Contract (both JMAP-guarded; both use `deps.fetchFn ?? fetch` like `/events`):**

`POST /api/mail/blobs`:
- Upload target: `session.uploadUrl.replaceAll("{accountId}", encodeURIComponent(session.accountId))`. Empty `uploadUrl` → 502 `stalwart_unavailable`.
- Forward: method POST, headers `authorization` (Basic) + `content-type` from the incoming request (`?? "application/octet-stream"`), body `c.req.raw.body` (stream passthrough; include `duplex: "half"` in the fetch init — required for streaming request bodies).
- Upstream non-ok → 502 `stalwart_unavailable`. Success → parse upstream JSON `{ blobId, type, size }` → respond with `blobUploadResultSchema`-shaped body (map `type ?? "application/octet-stream"`, `size ?? 0`).

`GET /api/mail/blobs/:blobId?name=<n>&type=<t>&dl=<0|1>`:
- Download target: `session.downloadUrl` with `{accountId}`, `{blobId}`, `{name}` (default `"attachment"`), `{type}` (default `"application/octet-stream"`) — all `encodeURIComponent`-ed via `replaceAll`. Empty template → 502.
- Forward the incoming `range` header when present. Upstream non-ok (and not 206) → 502. Success → passthrough Response with upstream body and status (200/206), headers: `content-type` (upstream's or the `type` param), `content-length`/`content-range`/`accept-ranges` copied from upstream when present, `cache-control: private, max-age=31536000, immutable` (blobs are immutable), `content-disposition`: `inline` when `dl` != "1", else `attachment`, both with `filename*=UTF-8''<rfc5987-encoded name>` (use `encodeURIComponent`).

- [ ] **Step 1: Failing test** — stub fetchFn capturing calls; session stub with `uploadUrl: "https://mail.test/upload/{accountId}/"`, `downloadUrl: "https://mail.test/dl/{accountId}/{blobId}/{name}?accept={type}"`. Cases: upload happy path (assert upstream URL substitution, auth header present, response parses with blobUploadResultSchema); upload upstream 500 → 502; download happy path (assert URL substitution incl. encoded name, `cache-control` immutable, `content-disposition` inline with filename, body passthrough); download with `dl=1` → attachment disposition; download forwards `range` header and passes upstream 206 + `content-range` through; empty templates → 502.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add attachment blob upload and download streaming`

---

### Task 5: Send endpoint

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `POST /send`)
- Test: `apps/server/src/modules/mail/send.test.ts`

**Contract:** `POST /api/mail/send`, body `sendEmailSchema` (400 `invalid_body` incl. malformed JSON).

Flow (two JMAP requests):
1. Lookup request: `[["Identity/get", { accountId, ids: [identityId] }, "i"], ["Mailbox/get", { accountId, properties: ["id", "role"] }, "m"]]`. Identity missing → 400 `{ code: "invalid_identity", message: "errors.invalid_identity" }`. From the mailbox list find `role === "drafts"` and `role === "sent"` ids; missing either → 502 `{ code: "mailbox_roles_missing", message: "errors.mailbox_roles_missing" }`.
2. Send request:

```ts
const create: Record<string, unknown> = {
  from: [{ name: identity.name || null, email: identity.email }],
  to: body.to, cc: body.cc, bcc: body.bcc,
  subject: body.subject,
  keywords: { $seen: true },
  mailboxIds: { [draftsId]: true },
  bodyValues: { t: { value: body.textBody }, ...(body.htmlBody ? { h: { value: body.htmlBody } } : {}) },
  textBody: [{ partId: "t", type: "text/plain" }],
  ...(body.htmlBody ? { htmlBody: [{ partId: "h", type: "text/html" }] } : {}),
  ...(body.attachments.length > 0
    ? { attachments: body.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: "attachment" })) }
    : {}),
  ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}),
  ...(body.references ? { references: body.references } : {}),
};

[
  ["Email/set", { accountId, create: { draft: create } }, "e"],
  ["EmailSubmission/set", {
    accountId,
    create: { sub: { emailId: "#draft", identityId: body.identityId } },
    onSuccessUpdateEmail: {
      "#sub": {
        [`mailboxIds/${draftsId}`]: null,
        [`mailboxIds/${sentId}`]: true,
        "keywords/$draft": null,
      },
    },
  }, "s"],
]
```

- `Email/set` response `notCreated.draft` → 502 `{ code: "send_failed", message: "errors.send_failed" }`; `EmailSubmission/set` response `notCreated.sub` → same. Success (submission `created.sub` present) → 200 `{ ok: true }`.

- [ ] **Step 1: Failing test** — stub jmap capturing both requests. Cases: (1) happy path with html + attachment + reply headers: assert the create object shape (from built from identity, bodyValues t/h, attachments array, inReplyTo passthrough, drafts mailbox), the submission backrefs (`emailId: "#draft"`, `onSuccessUpdateEmail` patch with drafts→null/sent→true), and 200 `{ok:true}`; (2) unknown identity → 400 `invalid_identity` and NO second request; (3) missing sent role → 502 `mailbox_roles_missing`; (4) submission notCreated → 502 `send_failed`; (5) zero recipients → 400 `invalid_body`.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add send endpoint via jmap email submission`

---

### Task 6: Verification sweep

**Files:** none new — verification and ledger only (wiring needs no change: all routes live in the existing mail router already mounted in index.ts).

- [ ] **Step 1:** `bun run typecheck` (root, 3 packages) and `bun run test` (root; Postgres 5434 up) — all green.
- [ ] **Step 2:** Dev container sanity: recreate `dev`, poll health 200, `curl -s http://localhost:8090/api/mail/signatures` → 401 envelope (session guard, works without Stalwart).
- [ ] **Step 3:** Commit only if anything needed fixing; otherwise report clean.

---

## Out of Scope

- Plan 4b: composer UI (TipTap), reply/reply-all prefill, signature settings screen, attachment download/preview UI wiring.
- Drafts autosave; scheduled send; read receipts.
