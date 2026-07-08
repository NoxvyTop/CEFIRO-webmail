# Prototype Parity Plan 2/2 — Keyboard Shortcuts, Overlay, Toasts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The prototype's interaction layer: global keyboard shortcuts (j/k move, e archive, s star, r reply, c compose, / search, ? overlay, Esc), the "? Atajos" header button + shortcuts overlay, transient toasts (archived/sent), and the shortcut hints (action bar + empty state).

**Architecture:** A `ToastProvider` context (pill bottom-center, README: fondo `--ink` texto `--bg`, fadeUp, auto-dismiss 2.6s). Shortcut listeners live where their state lives: j/k/e/s in `MessageList` (owns emails + selection), r in `ThreadView`, c in `MailPage`, `/` and `?` in the `App` shell. Every listener guards typing targets (input/textarea/select/contentEditable) and modifier keys. Reference: `docs/design/cefiro/README.md` §Interacciones, §Overlay Atajos, §Toast; capturas 04.

**Tech Stack:** existing. No new dependencies. No server changes.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys (es neutral / en); conventional commits; no AI attribution.
- TDD (RED captured → GREEN); FULL web suite + typecheck after every task; roles/aria preserved; new controls get i18n aria-labels.
- **Shortcut listeners MUST ignore events when `isTypingTarget(event)` or any of ctrl/meta/alt is pressed, and when `event.defaultPrevented`.** No shortcut may hijack typing in the composer/search/settings forms.
- Toast: `role="status"` (polite live region), auto-dismiss 2.6s, never stacks (a new toast replaces the current one).
- NEVER kill processes globally. Branch: `init-prototype-parity` (PR after this plan).

---

### Task 1: Toast infrastructure + archived/sent wiring

**Files:**
- Create: `apps/web/src/app/ui/toast.tsx`
- Modify: `apps/web/src/app/App.tsx` (mount ToastProvider around the shell), `apps/web/src/features/reader/ThreadView.tsx` (archive success toast), `apps/web/src/features/composer/Composer.tsx` (send success toast), locales (`composer.sent`, `mail.archivedHint`)
- Test: `apps/web/src/app/ui/toast.test.tsx`

**Interfaces (produces):** `ToastProvider` + `useToast(): { showToast(message: string): void }` — Tasks 2–3 reuse it.

- [ ] **Step 1: Failing tests** — `apps/web/src/app/ui/toast.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function Trigger({ message }: { message: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message)}>
      fire
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("shows a toast as a polite status and auto-dismisses after 2.6s", () => {
    render(
      <ToastProvider>
        <Trigger message="Correo archivado" />
      </ToastProvider>,
    );
    act(() => screen.getByText("fire").click());
    expect(screen.getByRole("status")).toHaveTextContent("Correo archivado");
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("replaces the current toast instead of stacking", () => {
    render(
      <ToastProvider>
        <Trigger message="uno" />
        <Trigger message="dos" />
      </ToastProvider>,
    );
    const [first, second] = screen.getAllByText("fire");
    act(() => first!.click());
    act(() => vi.advanceTimersByTime(1000));
    act(() => second!.click());
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("dos");
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(700));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<Trigger message="x" />)).toThrow(/ToastProvider/);
  });
});
```

- [ ] **Step 2: RED**, then implement `apps/web/src/app/ui/toast.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastContextValue = { showToast: (message: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((next: string) => {
    setMessage(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), TOAST_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {message && (
        <div
          role="status"
          className="fixed bottom-[26px] left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-sm text-canvas shadow-pop"
          style={{ animation: "fadeUp 0.22s ease-out" }}
        >
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
```

- [ ] **Step 3: Mount + wire.** In `App.tsx` wrap the returned shell (the outermost div) with `<ToastProvider>…</ToastProvider>`. In `ThreadView.tsx`: `const { showToast } = useToast();` and in the archive mutation's `onSuccess` call `showToast(`${t("mail.archived")} · ${t("mail.archivedHint")}`)`. In `Composer.tsx` `handleSend`: after a successful `send()` call `showToast(t("composer.sent"))` before `onClose()`. i18n: `composer.sent` = "Email sent" / "Correo enviado"; `mail.archivedHint` = "press e to archive faster" / "pulsa e para archivar más rápido". NOTE: composer/thread-view tests render without the provider — they will now throw. Wrap those test renders with `<ToastProvider>` (mechanical, do not change assertions), or render via routes where App already provides it — follow each file's existing style.

- [ ] **Step 4: GREEN + FULL web suite + typecheck.**
- [ ] **Step 5: Commit** — `feat(web): toast notifications for archive and send`

---

### Task 2: Shortcut engine — j/k/e/s in the list, r in the reader, c in MailPage

**Files:**
- Create: `apps/web/src/app/ui/shortcuts.ts`
- Modify: `MessageList.tsx` (j/k/e/s + archive mutation + onArchived), `MailPage.tsx` (archiveMailboxId + onArchived to MessageList; c shortcut), `ThreadView.tsx` (r shortcut), locales (none new)
- Test: `apps/web/src/app/ui/shortcuts.test.ts` + extensions to `message-list.test.tsx`

**`shortcuts.ts`:**

```ts
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function isPlainShortcut(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isTypingTarget(event)
  );
}
```

Behavior:
- `MessageList` gains props `archiveMailboxId: string | null` and `onArchived?: (email: EmailSummary) => void`, plus an `archiveMutation` (`updateMessage(email.id, { mailboxIds: { [archiveMailboxId!]: true } })`; onSuccess: invalidate the list queryKey and `["mail","thread"]`, `showToast(`${t("mail.archived")} · ${t("mail.archivedHint")}`)`, call `onArchived?.(email)`).
- Window keydown effect in MessageList (deps: emails, selectedThreadId, archiveMailboxId): guard `isPlainShortcut`; `j`/`k` select next/previous email (opens it — call `handleSelect`; when nothing selected, `j` opens the first); `s` toggles star on the selected email (existing starMutation); `e` archives the selected email when `archiveMailboxId` is set. `event.preventDefault()` on handled keys.
- `MailPage`: passes `archiveMailboxId` and `onArchived={(email) => { if (email.threadId === threadParam) clear the thread param }}` to MessageList; adds its own keydown effect for `c` → `handleCompose()` (guarded).
- `ThreadView`: keydown effect for `r` → `openCompose(`reply:${lastEmail.id}`)` (guarded; only when a lastEmail exists).

Tests:
- `shortcuts.test.ts`: isTypingTarget true for input/textarea/select/contentEditable targets, false for body/button; isPlainShortcut false with ctrl/meta/alt or defaultPrevented.
- `message-list.test.tsx` (non-virtualized branch renders in jsdom — follow the file's existing fixtures): pressing `j` (fireEvent.keyDown(window, { key: "j" })) selects/opens the first email (onSelect called); with a selected email, `s` calls updateMessage with the $flagged toggle; `e` with archiveMailboxId="arch1" calls updateMessage with `{ mailboxIds: { arch1: true } }`; keys ignored when the event target is an input (render a real input, dispatch from it, assert no call).

- [ ] Steps: RED → implement → GREEN + FULL suite + typecheck → commit `feat(web): keyboard shortcuts for list, reader and compose`

---

### Task 3: Shortcuts overlay + header button + `/`, `?`, Esc + hints

**Files:**
- Create: `apps/web/src/app/ui/ShortcutsOverlay.tsx`
- Modify: `App.tsx` (header "? Atajos" button before UserMenu; `/` focuses search; `?` toggles overlay; overlay mount), `ThreadView.tsx` (action-bar hint, truncating, hidden below md), `MailPage.tsx` (empty-state hint), locales (`shortcuts.*` block)
- Test: `apps/web/src/app/ui/shortcuts-overlay.test.tsx`

**i18n — new top-level `shortcuts` block (both locales):**
- en: `{ "title": "Shortcuts", "move": "Move through the list", "archive": "Archive email", "star": "Star email", "reply": "Reply", "compose": "Compose", "search": "Search", "close": "Close / dismiss", "hint": "j / k to move · e archives · c composes", "listHint": "j / k to move" }`
- es: `{ "title": "Atajos", "move": "Moverse por la lista", "archive": "Archivar correo", "star": "Destacar correo", "reply": "Responder", "compose": "Redactar", "search": "Buscar", "close": "Cerrar / salir", "hint": "j / k para moverte · e archiva · c redacta", "listHint": "j / k para moverte" }`

**ShortcutsOverlay** (README §Overlay Atajos: centered 400px card, 2-column grid, closes on outside click):

```tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

type ShortcutsOverlayProps = { open: boolean; onClose: () => void };

export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows: Array<[string, string]> = [
    ["j / k", t("shortcuts.move")],
    ["e", t("shortcuts.archive")],
    ["s", t("shortcuts.star")],
    ["r", t("shortcuts.reply")],
    ["c", t("shortcuts.compose")],
    ["/", t("shortcuts.search")],
    ["Esc", t("shortcuts.close")],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(3,5,9,0.55)]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("shortcuts.title")}
        onClick={(event) => event.stopPropagation()}
        className="w-[400px] rounded-[14px] border border-line bg-panel p-5 shadow-pop"
      >
        <h2 className="mb-4 text-sm font-semibold">{t("shortcuts.title")}</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          {rows.map(([keys, label]) => (
            <div key={keys} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="justify-self-end">
                <kbd className="rounded border border-line bg-soft px-1.5 text-[11px]">{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
```

App wiring:
- State `showShortcuts`; header button placed just BEFORE the UserMenu wrapper: ghost style `shrink-0 rounded-md border border-line px-3 py-1 text-sm text-muted hover:bg-hover`, content `? {t("shortcuts.title")}`, `aria-haspopup="dialog"`, onClick toggles.
- Search input gets a ref. App-level keydown effect (guarded by `isPlainShortcut`): `/` → preventDefault + focus the search input; `?` → preventDefault + toggle overlay.
- `<ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />` rendered inside the provider.

Hints:
- ThreadView action bar: `<span className="ml-auto hidden truncate text-xs text-muted md:block">{t("shortcuts.hint")}</span>` as the LAST child of the 52px bar.
- MailPage empty state: under the selectMessage line add `<p className="text-xs text-muted">{t("shortcuts.listHint")}</p>`.

Tests (`shortcuts-overlay.test.tsx`): closed by default (open=false → no dialog); open renders dialog with title + all 7 kbd rows; Escape calls onClose; backdrop click calls onClose; card click does NOT.

- [ ] Steps: RED → implement → GREEN + FULL suite + typecheck → commit `feat(web): shortcuts overlay, header button and hints`

---

### Task 4: Verification sweep

- [ ] Full web + server suites, all typechecks, `bun run build` — green; report counts. No commit unless fixes needed.
