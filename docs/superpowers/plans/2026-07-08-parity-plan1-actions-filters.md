# Prototype Parity Plan 1/2 — Archive, Star, Starred View, Labels

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mail actions and filtered views the Céfiro prototype shows and the app lacks: archive (reader bar), star/unstar (reader bar + row star), a cross-mailbox "Destacados" view in the sidebar, and user-keyword labels (sidebar section with colored dots, row chips, header filter chip with ✕).

**Architecture:** JMAP already carries everything: star = `$flagged` keyword via the existing `PATCH /messages/:id` keywords patch; archive = full-replacement `mailboxIds: { [archiveId]: true }` via the same endpoint; labels = the email's non-`$` keywords. The ONLY server change is `GET /messages` gaining an optional `hasKeyword` filter (comma-separated, ANDed) and making `mailboxId` optional when `hasKeyword` is present (cross-mailbox starred view). Label colors rotate deterministically over the README's label palette. Reference: `docs/design/cefiro/README.md` §Etiquetas, §Interacciones; capturas 01.

**Tech Stack:** existing. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys (es neutral default / en); conventional commits; no AI attribution; no compiled `.js`.
- TDD per task (RED output captured, then GREEN); full web suite AND full server suite must pass after every task that touches the respective package; typecheck clean.
- **`hasKeyword` values are user-influenced and reach JMAP filters: validate each against `/^[A-Za-z0-9$_.-]{1,64}$/` server-side; reject otherwise with 400 `invalid_query`.**
- Roles/aria/testids preserved; new interactive controls get aria-labels via i18n.
- Design values: star active `#E8C24A`; label palette rotation `#F26565 #5B8DEF #E5A13D #34C79A`, chip = pill, color text + background at 14% opacity (README §Etiquetas).
- System keywords are `$`-prefixed by JMAP convention: user labels = keys NOT starting with `$` and NOT empty.
- NEVER kill processes globally. Branch: `init-prototype-parity` (single PR with Parity Plan 2).

---

### Task 1: Server — `hasKeyword` filter, optional `mailboxId`

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (GET /messages + `buildMessagesFilter`)
- Test: `apps/server/src/modules/mail/messages-keywords.test.ts` (new, harness copied from `messages-groups.test.ts`)

**Interfaces (produces):** `GET /api/mail/messages` accepts `hasKeyword` (comma-separated keyword list; each ANDed as `{ hasKeyword }`) and requires AT LEAST ONE of `mailboxId` / `hasKeyword` (400 `invalid_query` when both absent, or when any keyword fails the charset rule).

- [ ] **Step 1: Write the failing tests** — `apps/server/src/modules/mail/messages-keywords.test.ts` (copy the exact `makeApp`/`stubJmap`/beforeAll harness from `messages-groups.test.ts`, then these cases):

```ts
describe("GET /api/mail/messages — keyword filters", () => {
  it("filters by a single keyword combined with the mailbox", async () => {
    // request: /api/mail/messages?mailboxId=mb1&hasKeyword=%24flagged
    // assert Email/query filter is { operator: "AND", conditions: [{ inMailbox: "mb1" }, { hasKeyword: "$flagged" }] }
  });

  it("allows a cross-mailbox query with only hasKeyword", async () => {
    // request: /api/mail/messages?hasKeyword=%24flagged
    // assert 200 and Email/query filter is exactly { hasKeyword: "$flagged" }
  });

  it("ANDs multiple comma-separated keywords", async () => {
    // request: ?mailboxId=mb1&hasKeyword=%24flagged,urgent
    // assert conditions include { inMailbox }, { hasKeyword: "$flagged" }, { hasKeyword: "urgent" }
  });

  it("rejects a request with neither mailboxId nor hasKeyword", async () => {
    // assert 400 invalid_query
  });

  it("rejects keywords with an invalid charset", async () => {
    // request: ?mailboxId=mb1&hasKeyword=bad%20keyword  (space)
    // assert 400 invalid_query
  });
});
```

Write them as REAL tests against the harness (assert on the captured `calls` like `messages-groups.test.ts` does).

- [ ] **Step 2: RED** — `cd apps/server && bun run test -- src/modules/mail/messages-keywords.test.ts` fails.

- [ ] **Step 3: Implement** in `apps/server/src/modules/mail/router.ts`:

Add near the other helpers:

```ts
const KEYWORD_PATTERN = /^[A-Za-z0-9$_.-]{1,64}$/;
```

Extend `buildMessagesFilter`'s input with `mailboxId?: string` (now optional) and `hasKeywords: string[]`:

```ts
function buildMessagesFilter(input: {
  mailboxId?: string;
  query?: string;
  to?: string;
  excludeTo: string[];
  hasKeywords: string[];
}): JmapFilter {
  const conditions: JmapFilter[] = [];
  if (input.mailboxId) conditions.push({ inMailbox: input.mailboxId });
  for (const keyword of input.hasKeywords) conditions.push({ hasKeyword: keyword });
  if (input.query) conditions.push({ text: input.query });
  if (input.to) conditions.push(recipientMatch(input.to));
  if (input.excludeTo.length > 0) {
    conditions.push({ operator: "NOT", conditions: input.excludeTo.map(recipientMatch) });
  }
  return conditions.length === 1 ? conditions[0]! : { operator: "AND", conditions };
}
```

In the route, replace the mandatory-mailboxId guard with:

```ts
    const mailboxId = c.req.query("mailboxId");
    const hasKeywords =
      c.req
        .query("hasKeyword")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    if (!mailboxId && hasKeywords.length === 0) {
      return c.json(
        { code: "invalid_query", message: "errors.invalid_query", traceId: c.get("traceId") },
        400,
      );
    }
    if (hasKeywords.some((keyword) => !KEYWORD_PATTERN.test(keyword))) {
      return c.json(
        { code: "invalid_query", message: "errors.invalid_query", traceId: c.get("traceId") },
        400,
      );
    }
```

and pass `hasKeywords` (plus the now-optional `mailboxId`) into `buildMessagesFilter`.

- [ ] **Step 4: GREEN + full server suite** — new file passes; `bun run test` full PASS (the old "requires mailboxId" test still passes: no hasKeyword there); `bun run typecheck` clean.
- [ ] **Step 5: Commit** — `feat(mail): keyword filters and cross-mailbox queries on messages`

---

### Task 2: Client — star mutation, archive helper, reader/row actions

**Files:**
- Modify: `apps/web/src/features/mailbox/api.ts` (fetchMessages signature), `apps/web/src/features/mailbox/MessageList.tsx` (row star + star mutation + optional mailboxId), `apps/web/src/features/reader/ThreadView.tsx` (Archivar/Destacar in the action bar), `apps/web/src/features/mailbox/MailPage.tsx` (archiveMailboxId prop wiring), `apps/web/src/app/ui/icons.tsx` (StarIcon, StarFilledIcon, ArchiveIcon), locales (mail.archive/star/unstar keys)
- Test: extend `apps/web/src/features/mailbox/message-list.test.tsx` + `apps/web/src/features/reader/thread-view.test.tsx`

**Interfaces:**
- `fetchMessages` input becomes `{ mailboxId?: string; hasKeyword?: string; position; limit; query?; to?; excludeTo? }` — sets each param only when present.
- `MessageList` props: `mailboxId?: string` (optional now) + `hasKeyword?: string`; queryKey gains both.
- `ThreadView` props gain `archiveMailboxId: string | null` (MailPage passes `mailboxes.find(m => m.role === "archive")?.id ?? null`).

Behavior:
- Row star: button (aria-label `t(starred ? "mail.unstar" : "mail.star")`, `onClick` stopPropagation) toggling `$flagged` via `updateMessage(email.id, { keywords: { $flagged: !starred } })` with optimistic cache update mirroring `markSeenMutation` exactly (same onMutate/onError shape). Icon: `StarFilledIcon` colored `#E8C24A` when starred, `StarIcon` `text-muted` otherwise.
- Reader bar order per prototype: [back (lg:hidden)] Archivar · Destacar · Responder · Responder a todos · Reenviar. Archivar (ArchiveIcon + label): `updateMessage(lastEmail.id, { mailboxIds: { [archiveMailboxId]: true } })`, then invalidate `["mail"]` queries and clear the `thread` param (back to list). Hidden when `archiveMailboxId` is null OR the email is already only in the archive mailbox. Destacar: toggles `$flagged` on `lastEmail`, invalidates the thread + messages queries; label switches star/unstar.

i18n (both locales): `mail.archive` ("Archive" / "Archivar"), `mail.star` ("Star" / "Destacar"), `mail.unstar` ("Unstar" / "Quitar destacado"), `mail.archived` ("Email archived" / "Correo archivado") — the toast copy lands in Plan 2, key added now.

Icons (same stroke conventions as the existing set):
- `StarIcon`: path `M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9Z`
- `StarFilledIcon`: same path with `fill="currentColor"` stroke none
- `ArchiveIcon`: `rect x3 y4 w18 h4 rx1` + `M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8` + `M10 12h4`

- [ ] **Step 1: RED** — add the failing tests first:
  - message-list.test: a row shows the star button (aria-label from i18n) and clicking it calls `updateMessage` with `{ keywords: { $flagged: true } }` (mock `./api` like the file already mocks fetchers — read it and follow its style).
  - thread-view.test: action bar shows Archivar and Destacar (role+name); clicking Archivar calls `updateMessage(lastEmailId, { mailboxIds: { arch1: true } })` (pass `archiveMailboxId="arch1"` through however the test renders ThreadView — read the file; if it renders via MailPage/wiring adapt minimally and document).
- [ ] **Step 2: Implement** everything above.
- [ ] **Step 3: GREEN + FULL web suite + typecheck.**
- [ ] **Step 4: Commit** — `feat(web): archive and star actions in list and reader`

---

### Task 3: Starred view (Destacados)

**Files:**
- Modify: `apps/web/src/features/mailbox/Sidebar.tsx` (Destacados entry with StarIcon after the mailbox list), `apps/web/src/features/mailbox/MailPage.tsx` (starred param wiring), locales (`mail.starredView`)
- Test: extend `apps/web/src/features/mailbox/sidebar.test.tsx` (entry renders + aria-current when selected) and add a MailPage-level assertion in `group-view.test.tsx`-style (clicking Destacados sets the starred view: MessageList receives `hasKeyword="$flagged"` — assert via the rendered list header title `t("mail.starredView")`).

Behavior:
- Sidebar gains props `starredSelected: boolean` + `onSelectStarred: () => void`; renders a row styled exactly like mailbox rows (h-[38px], aria-current when selected) with `StarIcon` + `t("mail.starredView")` placed directly AFTER the mailboxes `<ul>`.
- MailPage: URL param `starred=1` (set by `onSelectStarred`, clearing `mailbox`/`thread`/`group`/`label` params; `handleSelectMailbox` and `handleSelectGroup` clear `starred`). When active: MessageList gets `hasKeyword="$flagged"`, `mailboxId={undefined}`, `title={t("mail.starredView")}`; the group toggle row hides.
- i18n: `mail.starredView` = "Starred" / "Destacados".

- [ ] Steps: RED → implement → GREEN + full suite + typecheck → commit `feat(web): starred view across mailboxes`

---

### Task 4: Labels — sidebar section, row chips, header filter chip

**Files:**
- Create: `apps/web/src/app/ui/labels.ts` (deterministic label colors)
- Modify: `MessageList.tsx` (derive labels → `onLabels` callback; row chips; header filter chip with ✕), `MailPage.tsx` (label param + availableLabels state), `Sidebar.tsx` (ETIQUETAS section), locales (`mail.labels`, `mail.clearLabel`)
- Test: `apps/web/src/app/ui/labels.test.ts` (determinism) + extensions to sidebar/message-list tests

**`labels.ts`:**

```ts
const LABEL_COLORS = ["#F26565", "#5B8DEF", "#E5A13D", "#34C79A"];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function labelColor(label: string): string {
  return LABEL_COLORS[hashString(label.toLowerCase()) % LABEL_COLORS.length]!;
}

export function labelBackground(label: string): string {
  const hex = labelColor(label);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

export function userLabels(keywords: Record<string, boolean>): string[] {
  return Object.keys(keywords)
    .filter((key) => keywords[key] && !key.startsWith("$"))
    .sort();
}
```

Behavior:
- MessageList: `useEffect` over the flattened emails derives the union of `userLabels(email.keywords)` and calls a new optional prop `onLabels?: (labels: string[]) => void` (only when the set actually changed — compare joined strings to avoid loops). Rows render up to 2 label chips after the preview line: pill `text-[11px] px-2 rounded-full` with `style={{ color: labelColor(l), background: labelBackground(l) }}`.
- Header filter chip: new props `activeLabel?: string` + `onClearLabel?: () => void`; when active, the 52px header shows after the title a pill chip (label name + ✕ button aria-label `t("mail.clearLabel")`).
- MailPage: URL param `label=<keyword>`; `availableLabels` state fed by `onLabels`; Sidebar gets `labels`, `selectedLabel`, `onSelectLabel(label)` (toggles: same label → clears). The MessageList `hasKeyword` combines: starred view → `$flagged`; label active → the label; both → `"$flagged," + label` (server ANDs them).
- Sidebar ETIQUETAS section (styled like the GRUPOS header, README: 11px 700 tracking 0.12em) below Destacados: one 34px row per label with a 9px rounded-[3px] color dot + name; `aria-current` when selected. Section hidden when no labels.
- i18n: `mail.labels` = "Labels" / "Etiquetas"; `mail.clearLabel` = "Clear label filter" / "Quitar filtro de etiqueta".

- [ ] Steps: RED (labels.test determinism + chip render + sidebar section) → implement → GREEN + FULL suites + typecheck → commit `feat(web): keyword labels with sidebar filters and row chips`

---

### Task 5: Verification sweep

- [ ] Full web + server suites, typecheck web/server/shared, `bun run build` — all green; report counts. No commit unless fixes were needed.
