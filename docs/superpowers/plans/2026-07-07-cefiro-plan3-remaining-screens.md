# Céfiro Plan 3/4 — Remaining Screens (settings, admin, setup)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Céfiro token vocabulary to settings, admin and setup — the screens the design handoff doesn't cover — keeping their current structure (adaptation spec §10: same tokens, no new layouts). Closes the re-skin tanda; the branch PR follows this plan.

**Architecture:** Mechanical class swaps per the audited inventory, with three standing mappings decided here: (1) bare `border` → `border-line` uniformly; (2) primary submit `bg-blue-600 … text-white` → `rounded-[11px] bg-accent … font-semibold text-accent-ink` (the established button pattern); (3) success greens → `text-accent` (mint is the brand's positive color), errors → `text-danger`, error banners → `border-danger/40 bg-soft text-danger`. SetupPage additionally gets base control styling (it is currently unstyled).

**Tech Stack:** existing. No new dependencies. No server changes. No behavior changes at all in this plan.

## Global Constraints

- English code/comments/commits; conventional commits; no AI attribution.
- VISUAL ONLY: every role, aria-*, handler, conditional and text node byte-identical. Tests select by role/label/text (audited — none select by class); the full web suite must pass after every task with ZERO test-file edits expected. A failing test means a real breakage — fix the source, never the selector.
- Standard control treatment (used across all three tasks):
  - inputs/selects/textareas: `rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent` (keep any existing sizing/extra classes in place, swap only the visual parts)
  - secondary buttons: bare `border` → `border-line`, plus ` hover:bg-hover` appended
  - primary submit buttons: `rounded-md bg-blue-600 px-3 py-1 text-sm text-white` → `rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink transition hover:brightness-[1.07] active:scale-[0.98]` (preserve `disabled:opacity-50` where present)
  - errors: `text-red-600`/`text-red-700` → `text-danger`; success: `text-green-700` → `text-accent`
- NEVER kill processes globally; every task runs `cd apps/web && bun run test` + `bun run typecheck` before committing.
- Branch: `init-ui-polish`.

---

### Task 1: Settings feature swaps

**Files:** `apps/web/src/features/settings/SettingsPage.tsx`, `FilterSettings.tsx`, `FilterRuleForm.tsx`, `SignatureSettings.tsx`, `VacationSettings.tsx`

- [ ] **Step 1: SettingsPage** — root `<main role="main" className="mx-auto flex max-w-2xl flex-col gap-6 p-6">` → `mx-auto flex min-h-full max-w-2xl flex-col gap-6 p-6` and the back-link `text-sm text-blue-700 underline` → `text-sm text-accent underline`. (Page background comes from `body` — already `var(--bg)`.)

- [ ] **Step 2: FilterSettings** — exact swaps:
- L135 banner: `flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700` → `flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/40 bg-soft p-2 text-sm text-danger`
- L142 retry button: `rounded-md border border-red-300 px-2 py-1 text-xs` → `rounded-md border border-danger/40 px-2 py-1 text-xs hover:bg-hover`
- L150 reapplied: `text-sm text-green-700` → `text-sm text-accent`
- L154 empty: `text-sm text-gray-600` → `text-sm text-muted`
- L161 row: bare `border` → `border-line`
- L172/L181 move buttons: `rounded-md border px-2 py-1 text-xs disabled:opacity-50` → `rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50`
- L196 toggle enabled branch: `rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700` → `rounded-md border border-accent/40 bg-sel px-2 py-1 text-xs text-accent`
- L197 toggle disabled branch: `rounded-md border px-2 py-1 text-xs text-gray-600` → `rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover`
- L208/L215 edit+delete: bare `border` → `border-line` + append ` hover:bg-hover`
- L231 new-rule: bare `border` → `border-line` + append ` hover:bg-hover`

- [ ] **Step 3: FilterRuleForm** — every bare `border` (the audited 14 occurrences) → `border-line`; inputs/selects among them additionally get the standard control treatment (`bg-soft text-ink outline-none focus:border-accent` — the remove/add buttons only get `border-line hover:bg-hover`); L270 submit → primary pattern (keep `disabled:opacity-50`).

- [ ] **Step 4: SignatureSettings** — L91 default badge: `rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700` → `rounded-full bg-sel px-2 py-0.5 text-xs text-accent`; bare borders (L86/100/107/120/134/157): list rows/buttons → `border-line` (+ ` hover:bg-hover` on buttons), the name input → standard control treatment; L163 save → primary pattern.

- [ ] **Step 5: VacationSettings** — bare borders (L92/104/116/127/143 — all form controls) → standard control treatment; L149 error: `text-sm text-red-700` → `text-sm text-danger`; L155 save → primary pattern (keep `self-start`); L158 saved: `text-sm text-green-700` → `text-sm text-accent`.

- [ ] **Step 6:** `cd apps/web && bun run test` (PASS, zero test edits) + `bun run typecheck` (clean).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/settings
git commit -m "feat(web): cefiro tokens across settings screens"
```

---

### Task 2: Admin feature swaps

**Files:** `apps/web/src/features/admin/AdminPage.tsx`, `RequireAdmin.tsx`, `UserRow.tsx`

- [ ] **Step 1: AdminPage** — root `<main>` gains nothing structural (body provides bg); swaps:
- L113 + L219 submit buttons → primary pattern.
- L118/L126/L225 errors: `text-sm text-red-600` → `text-sm text-danger`.
- The eight `rounded-md border p-1` controls (L78/87/97/110/191/199/208/216) → standard control treatment.

- [ ] **Step 2: RequireAdmin** — L16 `text-sm text-red-600` → `text-sm text-danger`; L19 link `text-sm text-blue-700 underline` → `text-sm text-accent underline`.

- [ ] **Step 3: UserRow** — L68 `border-t` → `border-t border-line`; L76/L102 controls → standard control treatment (keep the `text-xs` sizing where present); L89/L104/L109 buttons → `border-line` + ` hover:bg-hover`; L113 error `text-xs text-red-600` → `text-xs text-danger`.

- [ ] **Step 4:** `cd apps/web && bun run test` (PASS) + `bun run typecheck` (clean).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/admin
git commit -m "feat(web): cefiro tokens across admin screens"
```

---

### Task 3: Setup page base styling

**Files:** `apps/web/src/features/setup/SetupPage.tsx`

The page is currently unstyled (controls have no className). Add the Céfiro base treatment WITHOUT touching structure, labels, ids, handlers or text:

- [ ] **Step 1:** Every `<input>` and `<select>` in the page: add `className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"` (if one already has a className, append the visual classes instead).
- [ ] **Step 2:** Every submit/action `<button>`: primary pattern `className="self-start rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink transition hover:brightness-[1.07] active:scale-[0.98]"` — unless the button is visually secondary in context (e.g. a cancel/back), which gets `rounded-md border border-line px-3 py-1 text-sm hover:bg-hover`. Use judgment per button and list each decision in the report.
- [ ] **Step 3:** Any error/status text nodes: errors → `text-sm text-danger`, success/confirmation → `text-sm text-accent`, hints → `text-xs text-muted` (only where the element has no styling yet or uses raw grays/reds).
- [ ] **Step 4:** `cd apps/web && bun run test` (PASS — setup.test selects by label/text) + `bun run typecheck` (clean).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/setup/SetupPage.tsx
git commit -m "feat(web): cefiro base styling for setup page"
```

---

### Task 4: Final verification sweep (whole re-skin)

**Files:** none expected.

- [ ] **Step 1:** `cd apps/web && bun run test` — PASS.
- [ ] **Step 2:** `cd apps/web && bun run typecheck` + `cd packages/shared && bun run typecheck` — clean.
- [ ] **Step 3:** `cd apps/web && bun run build` — OK; re-confirm dist has space-grotesk woff2 and zero googleapis/gstatic references.
- [ ] **Step 4:** Repo-wide palette grep over ALL of `apps/web/src` (same patterns as Plan 2 Task 6 plus `bg-red-`, `text-red-`, `border-red-`, `bg-green-`, `text-green-`, `bg-blue-`, `border-blue-`): expected hits — ONLY the deliberate `bg-white` on the EmailBody iframe. Everything else is a finding; report, don't fix.
- [ ] **Step 5:** Bare-border grep: `rg -n 'className="[^"]*\bborder\b(?![-])' apps/web/src --pcre2` (or equivalent) to catch leftover untokenized borders in the three re-skinned features; report hits.
- [ ] **Step 6:** `cd apps/server && bun run test` — PASS (untouched).
