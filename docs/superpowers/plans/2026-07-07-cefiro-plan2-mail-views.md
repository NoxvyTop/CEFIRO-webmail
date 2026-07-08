# Céfiro Plan 2/4 — Mail Views Re-skin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the whole mail experience to the Céfiro design (docs/design/cefiro/README.md + capturas): header with logo/wordmark/search/avatar, nav column with the accent Redactar button, message-list rows with avatars and selection accents, the reading pane with action bar/article/brand seal, and the composer modal — all on the token utilities from Plan 1.

**Architecture:** Pure visual layer: token-class swaps plus layout adjustments prescribed by the handoff. NO behavior changes except two sanctioned relocations: the compose button moves from the header to the nav column (handoff layout), and the reply/reply-all/forward buttons move from below the last email to a reading-pane action bar (rendered ONCE — duplicate accessible names would break `getByRole` queries). Every `role`, `aria-*`, i18n key and text node is preserved; tests select by those, never by class.

**Tech Stack:** existing. No new dependencies. No server changes.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys; conventional commits; no AI attribution; no compiled `.js` committed.
- **Every `role`, `aria-label`, `aria-current`, `title`, i18n text node, and the `load-more-sentinel` testid stay EXACTLY as they are** unless a step explicitly says otherwise. The full web suite must pass after every task.
- Design values (heights, radii, tracking, shadows) come from docs/design/cefiro/README.md — transcribe, don't approximate.
- New tokens in this plan: `--danger: #F26565` and `--warn: #E5A13D` (label palette colors, same in both themes per the README) exposed as `text-danger`/`text-warn` etc.
- Sanitization and the sandboxed iframe in EmailBody are UNTOUCHED (only its container classes change).
- NEVER kill processes globally; every task runs the full web suite + `bun run typecheck` (apps/web) before committing.
- Branch: `init-ui-polish` (single PR after Plan 3).

---

### Task 1: Danger/warn tokens + login hex cleanup

**Files:**
- Modify: `apps/web/src/app/theme.css`, `apps/web/src/features/auth/LoginPage.tsx`

**Interfaces (produces):** utilities `text-danger`, `text-warn` (and other prefixes) used by Tasks 2–5.

- [ ] **Step 1:** In `apps/web/src/app/theme.css` add to BOTH theme blocks (`:root, :root[data-theme="night"]` and `:root[data-theme="light"]`) — the values are theme-independent per the README ("iguales en ambos temas") but live alongside the other vars for consistency:

```css
  --danger: #f26565;
  --warn: #e5a13d;
```

And add inside the `@theme inline` block:

```css
  --color-danger: var(--danger);
  --color-warn: var(--warn);
```

- [ ] **Step 2:** In `apps/web/src/features/auth/LoginPage.tsx` replace both occurrences of `text-[#F26565]` with `text-danger`.

- [ ] **Step 3:** Run `cd apps/web && bun run test` (PASS) and `bun run typecheck` (clean).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/theme.css apps/web/src/features/auth/LoginPage.tsx
git commit -m "feat(web): danger and warn tokens"
```

---

### Task 2: Header + Sidebar (nav column)

**Files:**
- Modify: `apps/web/src/app/App.tsx`, `apps/web/src/features/mailbox/Sidebar.tsx`, `apps/web/src/features/mailbox/MailPage.tsx` (pass `onCompose` to Sidebar; remove nothing else)
- Modify: `apps/web/src/app/locales/en.json` + `es.json` (add `app.searchShortcutHint` NOT needed — no new keys in this task)

**Interfaces:**
- Consumes: `CefiroLogo`, `Avatar`, tokens.
- Produces: `Sidebar` gains a REQUIRED `onCompose: () => void` prop (MailPage wires it to set `compose=new`, the exact logic currently in App's `handleCompose`).

Behavior notes:
- The compose button MOVES from the App header to the Sidebar (handoff: nav column starts with the 44px accent "Redactar" button). Its accessible name stays `t("composer.title")` so existing selectors keep working. Remove `handleCompose` from App.tsx along with the header button; add the equivalent param-setting in MailPage and pass it down.
- Everything else in the header keeps its handler and accessible name: search form, notifications button, admin/settings links, theme toggle, sign-out.
- The `signedInAs` paragraph is REPLACED by the user Avatar wrapped in a span with `aria-label={t("auth.signedInAs", { email: user.email })}` and `title={user.email}` — the accessible text is preserved as a label.

- [ ] **Step 1: Re-skin the App header** — in `apps/web/src/app/App.tsx`: add imports `import { CefiroLogo } from "./ui/CefiroLogo";` and `import { Avatar } from "./ui/Avatar";`. Delete the `handleCompose` function and the compose `<button>`. Replace the header JSX with:

```tsx
      <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-line bg-panel px-4 text-ink">
        <div className="flex min-w-[210px] items-center gap-3">
          <CefiroLogo size={32} />
          <div className="flex flex-col">
            <span className="text-[15px] font-bold tracking-[0.32em]">CÉFIRO</span>
            <span className="text-[10.5px] text-muted">{t("app.tagline")}</span>
          </div>
        </div>
        <form onSubmit={handleSearchSubmit} className="max-w-[560px] flex-1">
          <div className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-soft px-3">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0 text-muted">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder={t("mail.searchPlaceholder")}
              aria-label={t("mail.searchPlaceholder")}
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            />
            <kbd aria-hidden="true" className="rounded border border-line px-1.5 text-[11px] text-muted">/</kbd>
          </div>
        </form>
        {notificationPermission === "default" && (
          <button
            type="button"
            onClick={() => void handleEnableNotifications()}
            aria-label={t("mail.enableNotifications")}
            className="rounded-md border border-line px-2 py-1 text-sm hover:bg-hover"
          >
            🔔
          </button>
        )}
        {health.data && health.data.status !== "ok" && (
          <p className="text-sm text-warn">{t("health.degraded")}</p>
        )}
        {user?.role === "admin" && (
          <Link to="/admin" className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover">
            {t("admin.title")}
          </Link>
        )}
        <Link to="/settings" className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover">
          {t("settings.title")}
        </Link>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={t(theme === "night" ? "app.themeLight" : "app.themeNight")}
          className="rounded-md border border-line px-2 py-1 text-sm hover:bg-hover"
        >
          {theme === "night" ? "☀" : "🌙"}
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover"
        >
          {t("auth.signOut")}
        </button>
        {user && (
          <span aria-label={t("auth.signedInAs", { email: user.email })} title={user.email}>
            <Avatar name={user.displayName ?? null} email={user.email} size={36} />
          </span>
        )}
      </header>
```

IMPORTANT adaptation rule: keep whatever the current file uses for the health line — the snippet above only shows the degraded state because a permanent "ok" text is not in the design; if a test asserts the "ok" health text, keep the original conditional exactly as it was and only apply token classes. Same for `user.displayName` — check the `SessionUser` shape; if there is no `displayName` field, pass `name={null}`.

- [ ] **Step 2: Re-skin the Sidebar** — replace the JSX of `apps/web/src/features/mailbox/Sidebar.tsx` (add the `onCompose: () => void` prop to its props type; add the CefiroLogo import is NOT needed here):

```tsx
  <aside className="flex w-[230px] shrink-0 flex-col gap-4 border-r border-line p-3">
    <button
      type="button"
      onClick={onCompose}
      className="flex h-11 items-center justify-center gap-2 rounded-[11px] bg-accent font-semibold text-accent-ink shadow-[0_2px_14px_rgba(111,227,193,0.25)] transition hover:brightness-[1.07] active:scale-[0.98]"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      {t("composer.title")}
    </button>
    <ul className="flex flex-col gap-1">
      {mailboxes.map((mailbox) => {
        const selected = mailbox.id === selectedMailboxId;
        return (
          <li key={mailbox.id}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelectMailbox(mailbox.id)}
              className="flex h-[38px] w-full items-center justify-between rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-semibold"
            >
              <span>{mailbox.name}</span>
              {mailbox.unreadEmails > 0 && (
                <span
                  aria-label={t("mail.unread", { count: mailbox.unreadEmails })}
                  className="text-xs font-semibold text-accent"
                >
                  {mailbox.unreadEmails}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
    {groups.length > 0 && (
      <nav aria-label={t("groups.title")} className="text-sm">
        <p aria-hidden="true" className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
          {t("groups.title")}
        </p>
        <ul className="flex flex-col gap-1">
          {groups.map((group) => {
            const selected = group.email === selectedGroup;
            return (
              <li key={group.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelectGroup(group.email)}
                  className="flex h-[34px] w-full items-center justify-between truncate rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-semibold"
                >
                  <span className="truncate">{group.email}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    )}
    <nav aria-label={t("modules.title")} className="mt-auto border-t border-line pt-2 text-sm text-muted">
      <span aria-current="true">{t("modules.mail")}</span>
    </nav>
  </aside>
```

- [ ] **Step 3: Wire `onCompose` in MailPage** — in `apps/web/src/features/mailbox/MailPage.tsx` add:

```tsx
  function handleCompose() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("compose", "new");
      return next;
    });
  }
```

and pass `onCompose={handleCompose}` to `<Sidebar … />`. (Adapt to the file's existing `setSearchParams` binding — it already uses `useSearchParams`.)

- [ ] **Step 4: Full suite + typecheck**

Run: `cd apps/web && bun run test` — Expected: PASS. If a test fails because it clicked the compose button expecting it in the header, update that test to keep querying `getByRole("button", { name: i18n.t("composer.title") })` (the button still exists, now inside the sidebar — role queries are location-independent, so a failure here would indicate a REAL breakage to fix, not a selector to loosen).
Run: `cd apps/web && bun run typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/App.tsx apps/web/src/features/mailbox/Sidebar.tsx apps/web/src/features/mailbox/MailPage.tsx
git commit -m "feat(web): cefiro header and nav column"
```

---

### Task 3: Message list

**Files:**
- Modify: `apps/web/src/features/mailbox/MessageList.tsx`, `apps/web/src/features/mailbox/MailPage.tsx` (list column sizing + list header + group toggle styling), `apps/web/src/app/locales/en.json` + `es.json` (add `mail.messageCount`)

**Interfaces:**
- Consumes: `Avatar`.
- Produces: `MessageList` gains optional prop `title?: string` — when set, renders the 52px list header (title + `t("mail.messageCount", { count: total })`). MailPage passes the selected mailbox's name (or the group address in group view).

- [ ] **Step 1: i18n** — add inside `mail` in both locales:
- en: `"messageCount": "{{count}} messages"`
- es: `"messageCount": "{{count}} correos"`

- [ ] **Step 2: Re-skin MessageList rows** — in `apps/web/src/features/mailbox/MessageList.tsx`:

Import `Avatar` (`import { Avatar } from "../../app/ui/Avatar";`). Replace `rowClassName` with:

```ts
function rowClassName(unread: boolean, selected: boolean) {
  const base =
    "flex cursor-pointer items-start gap-2 border-b border-line p-3 text-sm transition-colors hover:bg-hover";
  const weight = unread ? "font-semibold" : "font-normal";
  const highlight = selected
    ? "bg-sel border-l-[3px] border-l-accent pl-[9px]"
    : "border-l-[3px] border-l-transparent pl-[9px]";
  return [base, weight, highlight].join(" ");
}
```

Replace the row inner markup (keep the outer `div` with `role="option"`, `aria-selected`, `tabIndex`, handlers, and `rowClassName` call exactly as they are):

```tsx
      {unread && (
        <span aria-hidden="true" className="mt-4 h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
      )}
      <Avatar name={email.from[0]?.name ?? null} email={email.from[0]?.email ?? "?"} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px]">{fromLabel}</span>
          <span className="shrink-0 text-xs text-muted">{dateLabel}</span>
        </div>
        <div className="truncate text-[13.5px]">{subjectLabel}</div>
        <div className="truncate text-[12.5px] text-muted">{email.preview}</div>
      </div>
```

Change the virtualizer `estimateSize` from `64` to `84` (rows grew an avatar). Error/empty branches: `text-amber-700` → `text-warn`; `text-gray-500` → `text-muted`.

Add the optional header: extend the props type with `title?: string`; compute `const total = <the total count the query already exposes — first page's total field>`; wrap the current return content so both branches render below this header when `title` is provided:

```tsx
      {title && (
        <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="text-xs text-muted">{t("mail.messageCount", { count: total })}</span>
        </div>
      )}
```

(Adapt: the component may need a `flex h-full flex-col` wrapper so the header sits above the scrolling listbox; keep `role="listbox"` on the scroll container itself, unchanged.)

- [ ] **Step 3: MailPage list column** — in `apps/web/src/features/mailbox/MailPage.tsx`:
- List `<section>` classes: `flex-1 overflow-y-auto border-r` → `flex min-w-[280px] flex-[0_1_390px] flex-col overflow-y-auto border-r border-line bg-panel`.
- Reader `<section>` stays `flex-1 overflow-y-auto` (gets its skin in Task 4).
- Group toggle label classes: `flex items-center gap-2 border-b p-2 text-sm` → `flex items-center gap-2 border-b border-line p-2 text-sm text-muted`.
- Alert `text-amber-700` → `text-warn`.
- Pass `title` to MessageList: the selected group address when in group view, otherwise the selected mailbox's name (`mailboxes.find(...)`); fall back to `undefined` when unknown.

- [ ] **Step 4: Full suite + typecheck**

Run: `cd apps/web && bun run test` — Expected: PASS (rows still found by text; sidebar/group tests unaffected; message-list tests select by subject text).
Run: `cd apps/web && bun run typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/mailbox/MessageList.tsx apps/web/src/features/mailbox/MailPage.tsx apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json
git commit -m "feat(web): cefiro message list with avatars and selection accent"
```

---

### Task 4: Reading pane + empty state + brand seal

**Files:**
- Modify: `apps/web/src/features/reader/ThreadView.tsx`, `apps/web/src/features/reader/EmailBody.tsx`, `apps/web/src/features/mailbox/MailPage.tsx` (empty state), `apps/web/src/app/locales/en.json` + `es.json` (add `app.sentWith`, `app.sealMotto`)

**Interfaces:** consumes `Avatar`, `CefiroLogo`, tokens. The reply/reply-all/forward buttons move to a TOP action bar rendered once (ghost style) — same handlers, same accessible names, REMOVED from below the last email (no duplicates).

- [ ] **Step 1: i18n** — add inside `app` in both locales:
- en: `"sentWith": "Sent with", "sealMotto": "the wind that moves your team"`
- es: `"sentWith": "Enviado con", "sealMotto": "el viento que mueve tu equipo"`

- [ ] **Step 2: Re-skin ThreadView** — replace the return JSX (all helpers/hooks unchanged; imports add `Avatar`):

```tsx
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
        <button
          type="button"
          onClick={() => openCompose(`reply:${lastEmail.id}`)}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {t("composer.reply")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`reply-all:${lastEmail.id}`)}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {t("composer.replyAll")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`forward:${lastEmail.id}`)}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {t("composer.forward")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[780px] px-10 pb-16 pt-8" style={{ animation: "fadeUp 0.25s ease-out" }}>
          <h2 className="text-[26px] font-semibold leading-[1.25] tracking-[-0.01em]">
            {lastEmail.subject || t("mail.noSubject")}
          </h2>
          {emails.map((email) => {
            const toCcLabel = [...email.to, ...email.cc].map(addressLabel).filter(Boolean).join(", ");
            const sender = email.from[0];

            return (
              <article key={email.id} className="mt-6 border-b border-line pb-6 last:border-b-0">
                <div className="flex items-center gap-3">
                  <Avatar name={sender?.name ?? null} email={sender?.email ?? "?"} size={42} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-semibold">{addressLabel(sender)}</span>
                      <span className="text-xs text-muted">{formatDate(email.receivedAt)}</span>
                    </div>
                    {toCcLabel && <div className="truncate text-xs text-muted">{toCcLabel}</div>}
                  </div>
                </div>
                {email.attachments.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {email.attachments.map((attachment) => {
                      const attachmentName = attachment.name ?? "attachment";
                      return (
                        <span
                          key={attachment.blobId}
                          className="flex items-center gap-1 rounded-full bg-soft px-2 py-1 text-xs"
                        >
                          <span>
                            {attachmentName} ({formatSizeKb(attachment.size)})
                          </span>
                          <a
                            href={blobUrl(attachment.blobId, attachmentName, attachment.type, true)}
                            className="text-accent underline"
                          >
                            {t("attachments.download")}
                          </a>
                          {isPreviewable(attachment.type) && (
                            <a
                              href={blobUrl(attachment.blobId, attachmentName, attachment.type, false)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent underline"
                            >
                              {t("attachments.view")}
                            </a>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 text-[15px] leading-[1.65]">
                  <EmailBody bodyHtml={email.bodyHtml} bodyText={email.bodyText} />
                </div>
                {email.id === lastEmail.id && (
                  <div className="mt-5 border-t border-line pt-4">
                    <p className="text-[13.5px] font-semibold">{addressLabel(sender)}</p>
                    <p className="mt-4 flex items-center gap-2 text-[11.5px] text-muted">
                      <svg width="14" height="14" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true" className="text-accent">
                        <path d="M9 15h13a3.6 3.6 0 1 0-3.6-6.3" />
                        <path d="M7 21h19a3.6 3.6 0 1 1 3.6 6.3" />
                        <path d="M9 27h10" />
                      </svg>
                      <span>
                        {t("app.sentWith")}{" "}
                        <span className="font-bold tracking-[0.14em] text-accent">CÉFIRO</span> ·{" "}
                        {t("app.sealMotto")}
                      </span>
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
```

Error branch: `text-amber-700` → `text-warn`.

- [ ] **Step 3: EmailBody token swap** — in `apps/web/src/features/reader/EmailBody.tsx` (classes only; iframe/sandbox/sanitize logic untouched):
- Load-images button: `mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800` → `mb-2 rounded-md border border-warn/40 bg-soft px-2 py-1 text-xs text-warn`.
- Iframe: `h-64 w-full rounded-md border` → `h-64 w-full rounded-md border border-line bg-white` (email HTML assumes a light canvas; keep `bg-white` so light-styled emails stay readable in the Night theme).
- Fallback `pre`: `whitespace-pre-wrap text-sm` → `whitespace-pre-wrap text-sm leading-[1.65]`.
- Empty body `text-gray-500` → `text-muted`.

- [ ] **Step 4: MailPage empty state** — replace the reader placeholder `<p className="p-4 text-sm text-gray-500">{t("mail.selectMessage")}</p>` with:

```tsx
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <CefiroLogo size={52} />
            <p className="text-sm">{t("mail.selectMessage")}</p>
          </div>
```

(Add the CefiroLogo import to MailPage.)

- [ ] **Step 5: Full suite + typecheck**

Run: `cd apps/web && bun run test` — Expected: PASS. Watch `thread-view.test.tsx` (heading, attachment links, forward button — all preserved) and `wiring.test.tsx` (reply buttons still reachable by role+name in the action bar).
Run: `cd apps/web && bun run typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/reader/ThreadView.tsx apps/web/src/features/reader/EmailBody.tsx apps/web/src/features/mailbox/MailPage.tsx apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json
git commit -m "feat(web): cefiro reading pane with action bar and brand seal"
```

---

### Task 5: Composer modal + recipient chips + editor

**Files:**
- Modify: `apps/web/src/features/composer/Composer.tsx`, `apps/web/src/features/composer/RecipientField.tsx`, `apps/web/src/features/composer/RichTextEditor.tsx`

**Interfaces:** visual only. `role="dialog"`, every `aria-label`, and all handlers unchanged. The modal anchors bottom-right (handoff) instead of centered.

- [ ] **Step 1: Composer shell** — in `Composer.tsx`, class swaps only:
- Overlay div: `fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4` → `fixed inset-0 z-50 flex items-end justify-end bg-[rgba(3,5,9,0.55)] p-6`.
- Card div: `flex max-h-full w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-md bg-white p-4` → `flex max-h-full w-full max-w-[640px] flex-col gap-3 overflow-y-auto rounded-[14px] border border-line bg-panel p-4 shadow-[0_24px_70px_rgba(0,0,0,0.5)]`.
- Title h2: `text-lg font-semibold` → `-mx-4 -mt-4 flex h-12 items-center rounded-t-[14px] bg-soft px-4 text-sm font-semibold`.
- From/subject/signature selects+input: `rounded-md border p-1` → `rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent`.
- addCcBcc button: `self-start text-xs text-blue-700 underline` → `self-start text-xs text-accent underline`.
- Attachment remove button `text-gray-500` → `text-muted`; upload error `text-amber-700` → `text-warn`; sendError alert `text-amber-700` → `text-warn`.
- Cancel button: `rounded-md border px-3 py-1 text-sm` → `rounded-md border border-line px-3 py-1 text-sm hover:bg-hover`.
- Send button: `rounded-md bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50` → `flex items-center gap-2 rounded-[11px] bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-[0_2px_14px_rgba(111,227,193,0.25)] transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50`, and prepend a plane icon inside the button before the text:

```tsx
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
```

- [ ] **Step 2: RecipientField** — class swaps only:
- Chips container: `flex flex-wrap items-center gap-1 rounded-md border p-1` → `flex flex-wrap items-center gap-1 rounded-md border border-line bg-soft p-1 focus-within:border-accent`.
- Chip span: `flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs` → `flex items-center gap-1 rounded-full bg-sel px-2 py-0.5 text-xs`.
- Chip remove button: `text-gray-500` → `text-muted`.
- Input: `min-w-24 flex-1 border-none text-sm outline-none` → `min-w-24 flex-1 border-none bg-transparent text-sm text-ink outline-none placeholder:text-muted`.
- Invalid message: `text-xs text-amber-700` → `text-xs text-warn`.

- [ ] **Step 3: RichTextEditor** — class swaps only:
- Wrapper: `rounded-md border` → `rounded-md border border-line`.
- Toolbar: `flex items-center gap-1 border-b p-1` → `flex items-center gap-1 border-b border-line bg-soft p-1`.
- Each toolbar button: append ` hover:bg-hover` to its classes.
- Link input: `ml-1 rounded border px-1 py-0.5 text-xs` → `ml-1 rounded border border-line bg-panel px-1 py-0.5 text-xs text-ink outline-none focus:border-accent`.
- Invalid link message: `text-xs text-amber-700` → `text-xs text-warn`.
- Fallback contentEditable div: `min-h-32 rounded-md border p-2 text-sm` → `min-h-32 rounded-md border border-line p-2 text-sm`.

- [ ] **Step 4: Full suite + typecheck**

Run: `cd apps/web && bun run test` — Expected: PASS (composer tests select by dialog role + aria-labels, all preserved).
Run: `cd apps/web && bun run typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/composer/Composer.tsx apps/web/src/features/composer/RecipientField.tsx apps/web/src/features/composer/RichTextEditor.tsx
git commit -m "feat(web): cefiro composer modal anchored bottom right"
```

---

### Task 6: Verification sweep

**Files:** none expected.

- [ ] **Step 1:** `cd apps/web && bun run test` — PASS.
- [ ] **Step 2:** `cd apps/web && bun run typecheck` — clean.
- [ ] **Step 3:** `cd apps/web && bun run build` — OK.
- [ ] **Step 4:** Grep `apps/web/src/features/mailbox`, `features/reader`, `features/composer` and `app/App.tsx` for leftover raw palette classes (`bg-blue-`, `text-blue-`, `bg-gray-`, `text-gray-`, `border-gray-`, `bg-amber-`, `text-amber-`, `border-amber-`, `bg-white`, `text-white`) — expected hits: ONLY `bg-white` on the EmailBody iframe (deliberate) and `text-white`/palette classes inside `features/settings` + `features/admin` + `features/setup` (Plan 3 scope). Report any other hit as a finding.
- [ ] **Step 5:** `cd apps/server && bun run test` — PASS (untouched).
