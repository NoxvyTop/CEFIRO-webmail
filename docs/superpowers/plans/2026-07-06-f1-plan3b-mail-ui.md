# F1 Plan 3b/4 — Mail UI (three-pane webmail)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees read their mail in the browser: three-pane layout (sidebar mailboxes / message list / reading pane), virtualized infinite message list, full-text search, thread view with sanitized HTML in a sandboxed iframe (remote images blocked by default), optimistic read-marking, and real-time refresh via the SSE bridge.

**Architecture:** All data comes from the Plan 3a endpoints, validated with `@webmail/shared` contracts. URL search params (`mailbox`, `thread`, `q`) drive selection — the URL is the single source of navigation truth. Server state lives in TanStack Query with SSE-triggered invalidation. Mail HTML is sanitized with DOMPurify and rendered inside `<iframe sandbox="">` (no scripts, no same-origin) — the primary webmail attack surface, treated accordingly. See `docs/ARCHITECTURE.md`.

**Tech Stack:** existing web stack + `dompurify` ^3.2 + `@tanstack/react-virtual` ^3.10.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys, es (neutral Spanish) default / en fallback; conventional commits; no AI attribution; no compiled .js committed.
- TDD per task: failing output captured, then passing; both in the report.
- Zero runtime internet: both new deps come from npm at build; no CDNs.
- Security invariants: mail HTML never rendered without `sanitizeEmailHtml`; iframe always `sandbox=""`; remote images stripped by default with an explicit "load images" action; no mail content in console/logs.
- Tests: `bunx vitest run` in apps/web (jsdom); virtualized list components accept `virtualized={false}` for tests (jsdom has no layout).
- Run `bun install` from REPO ROOT when adding deps (commit bun.lock).
- NEVER kill processes globally.
- Branch: `init-mail-ui`.

---

### Task 1: Mail API client hooks

**Files:**
- Create: `apps/web/src/features/mailbox/api.ts`
- Modify: `apps/web/package.json` (add `"dompurify": "^3.2.0"`, `"@tanstack/react-virtual": "^3.10.0"` — installed once here for later tasks)
- Test: `apps/web/src/features/mailbox/api.test.ts`

**Interfaces (produces):**

```ts
import {
  mailboxSchema, messagesPageSchema, threadDetailSchema,
  type EmailUpdate, type Mailbox, type MessagesPage, type ThreadDetail,
} from "@webmail/shared";
import { z } from "zod";

export class MailApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "MailApiError";
  }
}

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

export async function fetchMailboxes(): Promise<Mailbox[]> {
  const res = await fetch("/api/mail/mailboxes");
  if (!res.ok) return parseError(res);
  return z.array(mailboxSchema).parse(await res.json());
}

export async function fetchMessages(input: {
  mailboxId: string; position: number; limit: number; query?: string;
}): Promise<MessagesPage> {
  const params = new URLSearchParams({
    mailboxId: input.mailboxId,
    position: String(input.position),
    limit: String(input.limit),
  });
  if (input.query) params.set("query", input.query);
  const res = await fetch(`/api/mail/messages?${params}`);
  if (!res.ok) return parseError(res);
  return messagesPageSchema.parse(await res.json());
}

export async function fetchThread(threadId: string): Promise<ThreadDetail> {
  const res = await fetch(`/api/mail/threads/${encodeURIComponent(threadId)}`);
  if (!res.ok) return parseError(res);
  return threadDetailSchema.parse(await res.json());
}

export async function updateMessage(id: string, update: EmailUpdate): Promise<void> {
  const res = await fetch(`/api/mail/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) return parseError(res);
}

export const PAGE_SIZE = 50;
```

- [ ] **Step 1: Write the failing test** — `apps/web/src/features/mailbox/api.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import {
  MailApiError, fetchMailboxes, fetchMessages, fetchThread, updateMessage,
} from "./api";

const mailbox = {
  id: "mb1", name: "Inbox", parentId: null, role: "inbox",
  sortOrder: 0, unreadEmails: 1, totalEmails: 2,
};

describe("mail api client", () => {
  it("fetches and validates mailboxes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([mailbox]))));
    expect((await fetchMailboxes())[0]?.name).toBe("Inbox");
  });

  it("throws MailApiError with the envelope code on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: "mail_not_configured", message: "x", traceId: "t" }), { status: 503 }),
    ));
    await expect(fetchMailboxes()).rejects.toMatchObject({
      status: 503, code: "mail_not_configured",
    });
  });

  it("builds the messages query string with search", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ total: 0, position: 0, emails: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchMessages({ mailboxId: "mb1", position: 50, limit: 50, query: "urgent" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("mailboxId=mb1");
    expect(url).toContain("position=50");
    expect(url).toContain("query=urgent");
  });

  it("PATCHes message updates", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    await updateMessage("e1", { keywords: { $seen: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/mail/messages/e1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ keywords: { $seen: true } });
  });

  it("rejects invalid response shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nope: 1 }))));
    await expect(fetchThread("t1")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`bunx vitest run src/features/mailbox` in apps/web).
- [ ] **Step 3: Add the two dependencies to apps/web/package.json, `bun install` from repo root, implement `api.ts` per the Interfaces block.**
- [ ] **Step 4: Full apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add mail api client and reader dependencies`

---

### Task 2: HTML sanitization module

**Files:**
- Create: `apps/web/src/features/reader/sanitize.ts`
- Test: `apps/web/src/features/reader/sanitize.test.ts`

**Interfaces (produces):**

```ts
export type SanitizedEmail = { html: string; hasRemoteImages: boolean };
export function sanitizeEmailHtml(
  raw: string,
  options: { allowRemoteImages: boolean },
): SanitizedEmail;
```

Contract:
- First pass: `DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["form", "input", "button"] })` — strips scripts/handlers by default.
- Second pass: parse with `new DOMParser().parseFromString(clean, "text/html")`; for every `img`, if `src` starts with `http://` or `https://`: when `allowRemoteImages` is false, remove the `src` attribute and set `data-blocked-src` to the original value; count them either way (the count drives `hasRemoteImages` regardless of allow state). `data:` and `cid:` URIs pass untouched. Return `document.body.innerHTML`.
- Also strip `target` attributes and add `rel="noopener noreferrer"` to all `a` elements; force `target="_blank"` so links never navigate the app.

- [ ] **Step 1: Write the failing test** — `apps/web/src/features/reader/sanitize.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./sanitize";

describe("sanitizeEmailHtml", () => {
  it("strips scripts and event handlers", () => {
    const out = sanitizeEmailHtml(
      `<p onclick="x()">hi</p><script>steal()</script>`,
      { allowRemoteImages: false },
    );
    expect(out.html).not.toContain("script");
    expect(out.html).not.toContain("onclick");
    expect(out.html).toContain("hi");
  });

  it("blocks remote images by default and flags them", () => {
    const out = sanitizeEmailHtml(
      `<img src="https://tracker.evil/pixel.png"><img src="data:image/png;base64,AAAA">`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("https://tracker.evil");
    expect(out.html).toContain("data-blocked-src");
    expect(out.html).toContain("data:image/png");
  });

  it("keeps remote images when allowed", () => {
    const out = sanitizeEmailHtml(
      `<img src="https://cdn.ok/logo.png">`,
      { allowRemoteImages: true },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).toContain("https://cdn.ok/logo.png");
  });

  it("hardens links", () => {
    const out = sanitizeEmailHtml(
      `<a href="https://x.test">link</a>`,
      { allowRemoteImages: false },
    );
    expect(out.html).toContain(`target="_blank"`);
    expect(out.html).toContain("noopener");
  });

  it("reports no remote images for clean content", () => {
    const out = sanitizeEmailHtml(`<p>plain</p>`, { allowRemoteImages: false });
    expect(out.hasRemoteImages).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement per contract.**
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add email html sanitizer with remote image blocking`

---

### Task 3: Three-pane layout, sidebar and header

**Files:**
- Create: `apps/web/src/features/mailbox/MailPage.tsx`, `apps/web/src/features/mailbox/Sidebar.tsx`
- Modify: `apps/web/src/app/App.tsx` (renders header + MailPage), locales es/en
- Test: `apps/web/src/features/mailbox/sidebar.test.tsx`

**Contract:**
- `MailPage` (owns URL state): reads `mailbox`, `thread`, `q` via `useSearchParams`. Loads mailboxes with TanStack Query (`["mail","mailboxes"]`, `fetchMailboxes`). When no `mailbox` param and mailboxes are loaded, it treats the mailbox with `role === "inbox"` (fallback: first mailbox) as selected WITHOUT writing the URL (computed default). Layout: `flex` row — `Sidebar` (w-56), message list placeholder (`<section aria-label={t("mail.listRegion")}>`, filled in Task 4), reading placeholder (`<section aria-label={t("mail.readerRegion")}>`, Task 5).
- `Sidebar`: renders mailbox names with unread badge when `unreadEmails > 0`; the selected mailbox gets `aria-current="true"`; clicking a mailbox sets `mailbox=<id>` and CLEARS `thread` and `q` params. Below the mailboxes, a module zone placeholder: `<nav aria-label={t("modules.title")}>` containing only the active "mail" module entry (prepares the Odoo module zone from the architecture).
- `App.tsx`: header bar (app title, `q` search input — wired in Task 6, signedInAs, signOut button) + `<MailPage/>` below. Keep the health status line in the header as a small dot/text (reuse existing query).
- i18n additions (es / en): `mail.listRegion` "Lista de mensajes"/"Message list", `mail.readerRegion` "Lectura"/"Reading pane", `mail.unread` "{{count}} sin leer"/"{{count}} unread", `modules.title` "Módulos"/"Modules", `modules.mail` "Correo"/"Mail", `mail.searchPlaceholder` "Buscar en el correo"/"Search mail", `mail.empty` "No hay mensajes"/"No messages", `mail.selectMessage` "Selecciona un mensaje"/"Select a message".

- [ ] **Step 1: Write the failing test** — `sidebar.test.tsx`: render routes at `/` with fetch mock: `/api/auth/me` → user, `/api/health` → ok, `/api/mail/mailboxes` → `[inbox(role inbox, unread 3), archive(role null)]`, `/api/mail/messages*` → empty page. Assert: both mailbox names render; "Inbox" has `aria-current="true"` by default (role-based); unread badge "3" visible; clicking "Archive" updates `aria-current` to Archive (URL-driven).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add three-pane mail layout with mailbox sidebar`

---

### Task 4: Virtualized message list with optimistic read-marking

**Files:**
- Create: `apps/web/src/features/mailbox/MessageList.tsx`
- Modify: `apps/web/src/features/mailbox/MailPage.tsx` (mount it)
- Test: `apps/web/src/features/mailbox/message-list.test.tsx`

**Contract:**
- Props: `{ mailboxId: string; query: string | null; selectedThreadId: string | null; onSelect(email: EmailSummary): void; virtualized?: boolean }` (default true).
- Data: `useInfiniteQuery` key `["mail","messages", mailboxId, query]`, page param = position, `fetchMessages({ mailboxId, position, limit: PAGE_SIZE, query })`, `getNextPageParam`: next position (`position + emails.length`) while `position + emails.length < total`, else undefined.
- Rendering: `@tanstack/react-virtual` `useVirtualizer` over the flattened rows when `virtualized` (overscan 10, estimateSize 64); plain `.map` when `virtualized === false` (jsdom tests). Row shows from-name (fallback email address), subject (fallback `t("mail.noSubject")` — add key: "(sin asunto)"/"(no subject)"), preview one-liner, date; unread (`!keywords.$seen`) rows get `font-semibold` and an unread dot; row `aria-selected` when its threadId === selectedThreadId. Last virtual row in view (or a "load more" sentinel row in non-virtualized mode) triggers `fetchNextPage`.
- Click behavior: calls `onSelect(email)`; when the email is unread, optimistically PATCH `{ keywords: { $seen: true } }` via a mutation with `onMutate` cache update (set `$seen` in the matching page entry) — no refetch on success (`invalidate` only on error).
- Empty state: `t("mail.empty")` when zero rows.

- [ ] **Step 1: Write the failing test** — cases: (1) renders rows from two stubbed pages? (single page enough: two emails, one unread) — unread has the semibold class; (2) empty page → `No hay mensajes`; (3) click on unread row → `onSelect` called AND a PATCH fetch to `/api/mail/messages/e1` with `$seen: true`; (4) click on an already-read row → no PATCH. Use `virtualized={false}` and a QueryClientProvider wrapper; stub fetch per-URL.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add virtualized message list with optimistic read state`

---

### Task 5: Reading pane — sanitized thread view

**Files:**
- Create: `apps/web/src/features/reader/ThreadView.tsx`, `apps/web/src/features/reader/EmailBody.tsx`
- Modify: `apps/web/src/features/mailbox/MailPage.tsx` (mount; wire onSelect → `thread` param)
- Test: `apps/web/src/features/reader/thread-view.test.tsx`

**Contract:**
- `ThreadView` props `{ threadId: string }`: query `["mail","thread", threadId]` → `fetchThread`. Renders subject (of the last email), then each email as a card: from (name or address), to/cc summary line, localized date, attachments chips (`name (size KB)` — no download link yet, title `t("mail.attachmentsSoon")`: "Descarga disponible próximamente"/"Download coming soon"), and `EmailBody`.
- `EmailBody` props `{ bodyHtml: string | null; bodyText: string | null }`: html → `sanitizeEmailHtml(bodyHtml, { allowRemoteImages })` with component-local `allowRemoteImages` state (default false); render `<iframe sandbox="" srcDoc={html} title={t("mail.emailContent")} />` (key: "Contenido del correo"/"Email content") with the sanitized html wrapped in a minimal document (`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;margin:8px;color:#111}</style></head><body>…</body></html>`); when `hasRemoteImages && !allowRemoteImages`, show a banner button `t("mail.loadImages")` ("Cargar imágenes"/"Load images") that flips the state. Text-only email → `<pre className="whitespace-pre-wrap">{bodyText}</pre>`. Neither → `t("mail.emptyBody")` ("(sin contenido)"/"(no content)").
- `MailPage`: `onSelect` sets `thread=<threadId>` param; no `thread` → `t("mail.selectMessage")` placeholder in the reader pane.

- [ ] **Step 1: Write the failing test** — stub fetch for a thread with: email A html body containing a remote image + a paragraph, one attachment `report.pdf` 2048 bytes; email B text-only. Assert: subject rendered; "Cargar imágenes" button present (remote image blocked); iframe present with `sandbox` attribute equal to `""` and srcDoc NOT containing the remote URL; clicking the button → srcDoc now contains the remote URL; attachment chip "report.pdf" visible; email B renders its text in a `pre`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add sanitized thread reading pane`

---

### Task 6: Search, SSE live refresh, notifications, final wiring

**Files:**
- Create: `apps/web/src/features/mailbox/useMailEvents.ts`
- Modify: `apps/web/src/app/App.tsx` (search input wiring), `apps/web/src/features/mailbox/MailPage.tsx` (use the hook), locales
- Test: `apps/web/src/features/mailbox/events.test.tsx`

**Contract:**
- Search: header input (placeholder `t("mail.searchPlaceholder")`) is a controlled input synced from the `q` param; submitting (Enter / form submit) sets `q` (and clears `thread`); clearing it removes the param. `MessageList` already keys queries by `query` — no extra work there.
- `useMailEvents(enabled: boolean)`: when enabled, opens `new EventSource("/api/mail/events")`; every `message` event → `queryClient.invalidateQueries({ queryKey: ["mail"] })` (coarse by design). While `document.hidden` and `Notification.permission === "granted"`, also fire `new Notification(t("mail.newMailNotification"))` ("Correo nuevo"/"New mail"). On EventSource `error`: close, retry after 15s (setTimeout, cleared on unmount). Cleanup closes the source. A small header bell-toggle button (aria-label `t("mail.enableNotifications")`: "Activar notificaciones"/"Enable notifications") calls `Notification.requestPermission()` — only rendered when permission is `"default"`.
- i18n keys above added to both catalogs.

- [ ] **Step 1: Write the failing test** — `events.test.tsx`: stub `EventSource` with a controllable fake class (capture instances, expose `emitMessage()`); render MailPage inside providers with fetch stubs; assert an EventSource was created for `/api/mail/events`; call `emitMessage()` → a spied `queryClient.invalidateQueries` was called with `["mail"]` prefix (create the QueryClient in the test to spy on it). Notification path: stub global `Notification` (constructor spy, `permission = "granted"`) + `document.hidden` true via `Object.defineProperty` → `emitMessage()` constructs a Notification.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full apps/web suite + `bun run typecheck` (root, all packages) + root `bun run test` (Postgres 5434 up) green.**
- [ ] **Step 5: Live verification** — recreate the dev container, poll health, open http://localhost:5173: login screen renders (no Stalwart configured locally, so after SSO-less state the mail pane shows the `mail_not_configured` error path gracefully — verify the app doesn't crash: the list/sidebar show their error/empty states). Capture a screenshot-free textual confirmation (curl 5173 → 200 and no build errors in `docker compose logs dev | tail`).
- [ ] **Step 6: Commit** — `feat(web): add search, sse live refresh and new-mail notifications`

---

## Error-state handling (applies across Tasks 3-6)

Queries that fail with `MailApiError` codes `mail_not_configured` / `mail_credentials_missing` render an inline informational banner in the affected pane (keys: `mail.errors.mail_not_configured` "El servidor de correo no está configurado"/"The mail server is not configured", `mail.errors.mail_credentials_missing` "Tu buzón no está vinculado todavía"/"Your mailbox is not linked yet", generic `mail.errors.generic` "No se pudo cargar el correo"/"Mail could not be loaded"). No retry storms: `retry: false` for 4xx/503 MailApiError in a shared `retry` option on these queries.

## Out of Scope

- Plan 4: composer, identities, signatures, send, attachment download/preview endpoints and UI.
- Label management UI (create/assign custom labels) — F1 exposes keywords via PATCH; full label UX arrives with Plan 4 polish.
- Mailbox tree nesting (parentId) — rendered flat in 3b.
