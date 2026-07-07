# F2 Plan 4/4 — Mail Groups (Model A: group copy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group mail (soporte@, ventas@…) that Stalwart copies into a member's own mailbox is browsable in a sidebar Groups zone (each of the user's non-primary addresses), and a per-user toggle controls whether that group mail also appears mixed in the main inbox or only in the Groups zone. Reply defaults to the person; send-as-the-company already works via F1 identities.

**Architecture:** No new mail is stored — the copy lives in the user's mailbox (Stalwart-side delivery). The Groups zone derives its list from the user's JMAP identities (non-primary addresses), reusing the F1 identities endpoint. Message filtering by recipient address uses JMAP `Email/query` recipient conditions (`to`/`cc`). The toggle is a per-user preference in `user_preferences` (no Stalwart write); when off, the inbox query excludes mail addressed to any group address via a JMAP `NOT` condition. See `docs/superpowers/specs/2026-07-06-phase2-admin-portal-design.md` §5.

**Tech Stack:** existing — Bun + Hono + TS, React + Vite, TanStack Query, i18next, Zod, Vitest. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys, es (neutral Spanish) default / en fallback; conventional commits; no AI attribution; no compiled `.js` committed.
- TDD per task: write the test, run it and SEE IT FAIL (capture output), implement, see it pass; both outputs in the report.
- Runtime-agnostic backend; error envelope `{ code, message, traceId }` with `message` an i18n key.
- The webmail never writes to Stalwart; group membership/delivery is Stalwart-managed. No new mail tables.
- Mail content never logged/audited; secrets never logged.
- `apps/server/vitest.config.ts` has `fileParallelism: false` — keep it.
- Postgres for integration tests: dev container on host port 5434, `DATABASE_URL` fallback `postgres://webmail:webmail@localhost:5434/webmail`.
- NEVER kill processes globally; prefer running inside the dev container.
- Every task runs `bun run typecheck` and its tests before committing.
- Branch: `init-mail-groups`.

---

### Task 1: User preferences repo + endpoints

**Files:**
- Create: `apps/server/src/infra/repos/user-preferences.ts`
- Modify: `packages/shared/src/api/mail.ts` (add the preferences schema), `apps/server/src/modules/mail/router.ts` (two session-guarded routes + `userPreferences` dep), `apps/server/src/index.ts` (construct + pass the repo)
- Test: `apps/server/src/modules/mail/preferences.test.ts`

**Interfaces (produces):**

`packages/shared/src/api/mail.ts` — append:

```ts
export const userPreferencesSchema = z.object({
  groupMailInMainInbox: z.boolean(),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userPreferencesUpdateSchema = z.object({
  groupMailInMainInbox: z.boolean().optional(),
});
export type UserPreferencesUpdate = z.infer<typeof userPreferencesUpdateSchema>;
```

`apps/server/src/infra/repos/user-preferences.ts` (the `user_preferences` table exists from F1: `user_id uuid pk, preferences jsonb not null default '{}'`):

```ts
import type { Db } from "../db/client";

const DEFAULTS = { groupMailInMainInbox: true };

export function createUserPreferencesRepo(sql: Db) {
  return {
    async get(userId: string): Promise<{ groupMailInMainInbox: boolean }> {
      const rows = await sql<{ preferences: Record<string, unknown> }[]>`
        select preferences from user_preferences where user_id = ${userId}
      `;
      const stored = rows[0]?.preferences ?? {};
      return {
        groupMailInMainInbox:
          typeof stored.groupMailInMainInbox === "boolean"
            ? stored.groupMailInMainInbox
            : DEFAULTS.groupMailInMainInbox,
      };
    },
    async merge(
      userId: string,
      patch: Record<string, unknown>,
    ): Promise<{ groupMailInMainInbox: boolean }> {
      await sql`
        insert into user_preferences (user_id, preferences)
        values (${userId}, ${sql.json(patch)})
        on conflict (user_id) do update set
          preferences = user_preferences.preferences || excluded.preferences
      `;
      return this.get(userId);
    },
  };
}

export type UserPreferencesRepo = ReturnType<typeof createUserPreferencesRepo>;
```

`router.ts` — add `userPreferences: UserPreferencesRepo` to `MailDeps`; add two routes guarded by `requireSession(deps.sessions)` ONLY (NOT `requireMail` — preferences work without Stalwart), reading the session user id from `c.get("user").userId`:
- `GET /api/mail/preferences` → `userPreferencesSchema` shape from `userPreferences.get(userId)`.
- `PUT /api/mail/preferences` → body `userPreferencesUpdateSchema` (400 `invalid_body` incl. malformed JSON); `userPreferences.merge(userId, parsed.data)`; return the resulting `UserPreferences`.

`index.ts` — construct `const userPreferences = createUserPreferencesRepo(db);` and pass it into `createMailRouter({ ... , userPreferences })`.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/mail/preferences.test.ts`. Real Postgres; seed a user + session token. Build `createApp({ mailRouter: createMailRouter({ sessions, mailCredentials, signatures, jmap: null, userPreferences }) })` (jmap null is fine — these routes don't need it). Cases:
  1. `GET /api/mail/preferences` without session → 401.
  2. As the user, before any set → `{ groupMailInMainInbox: true }` (default).
  3. `PUT { groupMailInMainInbox: false }` → 200 `{ groupMailInMainInbox: false }`; a subsequent `GET` returns false (persisted).
  4. `PUT {}` (empty patch) → 200 and keeps the prior value (merge, not overwrite).
  5. `PUT` malformed JSON → 400.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the schema, repo, routes, wiring.
- [ ] **Step 4: Full server + shared suites + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add user preferences repo and endpoints`

---

### Task 2: Message list — recipient filters (`to` / `excludeTo`)

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (`GET /messages` filter builder)
- Test: `apps/server/src/modules/mail/messages-groups.test.ts`

**Interfaces:**
- Consumes: existing `/messages` route (mailboxId + optional query/position/limit).
- Produces: `/messages` accepts two new optional query params:
  - `to=<address>` — group view: only mail whose To or Cc contains `<address>`.
  - `excludeTo=<a1,a2,...>` (comma-separated) — declutter: exclude mail whose To or Cc contains any listed address.
  They are independent; `to` is for the Groups zone, `excludeTo` for the main inbox when the toggle is off.

**Filter builder** (replace the single-line `filter` at router.ts ~439 with a helper):

```ts
type JmapFilter = Record<string, unknown>;

function recipientMatch(address: string): JmapFilter {
  return { operator: "OR", conditions: [{ to: address }, { cc: address }] };
}

function buildMessagesFilter(input: {
  mailboxId: string;
  query?: string;
  to?: string;
  excludeTo: string[];
}): JmapFilter {
  const conditions: JmapFilter[] = [{ inMailbox: input.mailboxId }];
  if (input.query) conditions.push({ text: input.query });
  if (input.to) conditions.push(recipientMatch(input.to));
  if (input.excludeTo.length > 0) {
    conditions.push({ operator: "NOT", conditions: input.excludeTo.map(recipientMatch) });
  }
  return conditions.length === 1 ? conditions[0]! : { operator: "AND", conditions };
}
```

In the route: parse `to` (single) and `excludeTo` (`c.req.query("excludeTo")?.split(",").map(s => s.trim()).filter(Boolean) ?? []`), then `const filter = buildMessagesFilter({ mailboxId, query, to, excludeTo });`. Everything else (Email/query + Email/get chaining, mapping, response) unchanged.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/mail/messages-groups.test.ts`. Reuse the messages test scaffolding (stub JmapClient capturing the `request` calls; Postgres for session/credential). Assert on the captured `Email/query` filter:
  1. `?mailboxId=inbox&to=soporte@x.com` → filter is `{ operator: "AND", conditions: [{ inMailbox: "inbox" }, { operator: "OR", conditions: [{ to: "soporte@x.com" }, { cc: "soporte@x.com" }] }] }`.
  2. `?mailboxId=inbox&excludeTo=soporte@x.com,ventas@x.com` → filter has a `{ operator: "NOT", conditions: [ recipientMatch(soporte), recipientMatch(ventas) ] }` alongside `{ inMailbox }`.
  3. `?mailboxId=inbox` (neither) → filter is exactly `{ inMailbox: "inbox" }` (unchanged from today).
  4. `?mailboxId=inbox&query=urgent&to=soporte@x.com` → filter AND-combines inMailbox + text + the to-match.
  Stub the JMAP responses so the route returns 200 and parses; the assertions are on the captured request filter.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the filter builder + param parsing.
- [ ] **Step 4: Full server suite + typecheck green** (existing messages tests must still pass — the no-param case is unchanged).
- [ ] **Step 5: Commit** — `feat(server): add recipient filters to the message list`

---

### Task 3: Web — preferences client, identities-derived groups, Sidebar Groups zone

**Files:**
- Create: `apps/web/src/features/mailbox/groups.ts` (derive groups + a preferences client)
- Modify: `apps/web/src/features/mailbox/api.ts` (extend `fetchMessages` with `to`/`excludeTo`), `apps/web/src/features/mailbox/Sidebar.tsx` (Groups zone), `apps/web/src/features/mailbox/MailPage.tsx` (pass identities/prefs; `group` URL param), locales
- Test: `apps/web/src/features/mailbox/groups.test.ts`, `apps/web/src/features/mailbox/sidebar-groups.test.tsx`

**Interfaces:**

`groups.ts`:

```ts
import { userPreferencesSchema, type Identity, type UserPreferences } from "@webmail/shared";
import { MailApiError } from "./api";

// The user's group addresses = their identities whose email differs from the primary.
export function deriveGroupAddresses(identities: Identity[], primaryEmail: string): Identity[] {
  const primary = primaryEmail.toLowerCase();
  return identities.filter((i) => i.email.toLowerCase() !== primary);
}

export async function fetchPreferences(): Promise<UserPreferences> {
  const res = await fetch("/api/mail/preferences");
  if (!res.ok) throw new MailApiError(res.status, "internal");
  return userPreferencesSchema.parse(await res.json());
}

export async function updatePreferences(patch: { groupMailInMainInbox?: boolean }): Promise<UserPreferences> {
  const res = await fetch("/api/mail/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new MailApiError(res.status, "internal");
  return userPreferencesSchema.parse(await res.json());
}
```

`api.ts` — extend `fetchMessages` input to `{ mailboxId; position; limit; query?; to?; excludeTo? }`; when `to` is set add `params.set("to", to)`; when `excludeTo` is a non-empty array add `params.set("excludeTo", excludeTo.join(","))`. Existing calls without these are unchanged.

`Sidebar.tsx` — below the mailboxes list and above the module zone, render a **Groups zone**: `<nav aria-label={t("groups.title")}>` listing the derived group addresses (from a `groups` prop). Each is a button that selects the group (calls an `onSelectGroup(address)` prop). The currently selected group (from the `selectedGroup` prop) gets `aria-current="true"`. If there are no groups, render nothing (the zone is absent). Keep the existing mailbox list and module zone intact.

`MailPage.tsx`:
- Load identities (`useQuery(["mail","identities"])` via the existing composer/api `fetchIdentities`, or import it) and preferences (`useQuery(["mail","preferences"], fetchPreferences)`).
- `group` URL param (via `useSearchParams`): when set, it's the selected group address.
- Compute `groups = deriveGroupAddresses(identities ?? [], user.email)`; pass to `Sidebar` with `onSelectGroup` (sets `group=<address>`, clears `thread`; clears `mailbox` selection is not needed — group view always uses the inbox) and `selectedGroup`.
- Selecting a mailbox clears the `group` param (mailbox and group are mutually exclusive views).

- i18n keys (es / en): `groups.title` "Grupos" / "Groups", `groups.showInInbox` "Mostrar en bandeja principal" / "Show in main inbox" (used by Task 4's toggle — add here).

- [ ] **Step 1: Write the failing tests.**
  - `groups.test.ts`: `deriveGroupAddresses` returns identities whose email differs from the primary (case-insensitive); excludes the primary; empty when only the primary exists. `fetchPreferences`/`updatePreferences` hit the right URLs and parse (stub fetch).
  - `sidebar-groups.test.tsx`: render `Sidebar` with a `groups` prop of two addresses → both appear under the "Grupos" region; clicking one calls `onSelectGroup` with its address; the `selectedGroup` one has `aria-current`. With an empty `groups` prop, the "Grupos" region is absent.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add groups zone and preferences client`

---

### Task 4: Web — group view filtering + main-inbox toggle

**Files:**
- Modify: `apps/web/src/features/mailbox/MessageList.tsx` (accept `to`/`excludeTo`), `apps/web/src/features/mailbox/MailPage.tsx` (compute filters from group + toggle; render the toggle), locales
- Test: `apps/web/src/features/mailbox/group-view.test.tsx`

**Contract:**
- `MessageList` props gain optional `to?: string` and `excludeTo?: string[]`; they flow into `fetchMessages` and into the infinite-query key (so switching group/toggle refetches). The query key becomes `["mail","messages", mailboxId, query, to ?? null, (excludeTo ?? []).join(",")]`.
- `MailPage` computes what to pass to `MessageList`:
  - **Group view** (`group` param set): `mailboxId` = the inbox mailbox id (find the mailbox with `role === "inbox"`, fallback first), `to = group`, `excludeTo = undefined`.
  - **Mailbox view** (no `group`): `mailboxId` = selected mailbox, `to = undefined`. If the selected mailbox is the inbox AND `preferences.groupMailInMainInbox === false`, pass `excludeTo = <all group addresses>` (the derived group identity emails); otherwise `excludeTo = undefined`.
- **The toggle control**: in the Groups zone header (Sidebar) OR at the top of the inbox view, render a checkbox/switch labelled `t("groups.showInInbox")` bound to `preferences.groupMailInMainInbox`. Toggling calls `updatePreferences({ groupMailInMainInbox: next })` (a mutation) and invalidates `["mail","preferences"]` and `["mail","messages"]` (so the inbox refetches with/without `excludeTo`). Only render the toggle when the user has at least one group address (otherwise it's meaningless).
- Reading, marking, replying in a group view use the existing MessageList/reader/composer unchanged (it's the user's own mail).

- [ ] **Step 1: Write the failing test** — `group-view.test.tsx`. Render `MailPage` (providers + memory router) with fetch stubbed per URL: `/api/auth/me` → a user; `/api/mail/mailboxes` → `[inbox]`; `/api/mail/identities` → `[{primary}, {soporte@}]`; `/api/mail/preferences` → `{groupMailInMainInbox:false}`; capture `/api/mail/messages?...` calls. Cases:
  1. At `/?group=soporte@x.com` → a `/api/mail/messages` request is made with `to=soporte@x.com` and the inbox mailboxId.
  2. At `/` (inbox, toggle off) → the messages request includes `excludeTo=soporte@x.com` (the derived group address).
  3. Toggling "Mostrar en bandeja principal" to on → `PUT /api/mail/preferences {groupMailInMainInbox:true}` fires, and the subsequent inbox request has no `excludeTo`.
  (Assert on captured request URLs; use `virtualized={false}` for MessageList as in the existing message-list test.)
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full apps/web suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(web): add group view filtering and main-inbox toggle`

---

### Task 5: Verification sweep + mark F2 complete

**Files:** Modify `docs/ARCHITECTURE.md` (mark F2 done).

- [ ] **Step 1:** `bun run typecheck` (root) and `bun run test` (root; Postgres 5434 up) — all green.
- [ ] **Step 2:** Dev container: recreate `dev`, poll `http://localhost:8090/api/health` until 200, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/api/mail/preferences   # 401 (session-guarded)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173                          # 200
docker compose -f docker-compose.dev.yml exec -T dev sh -c "cd apps/web && bunx vite build" 2>&1 | tail -2   # build succeeds
```

Capture the outputs.

- [ ] **Step 3:** In `docs/ARCHITECTURE.md`, update the Fases de entrega table: mark **F2 — Administración** as ✅ Completa, and add a one/two-line note that F2 delivered the admin portal (JIT provisioning, users/credential management with archive, dual-mode login, admin OIDC config) and mail groups (Model A). Keep it brief.

- [ ] **Step 4:** Commit — `docs: mark phase 2 complete` (plus any fix commit if Steps 1-2 surfaced something).

---

## Out of Scope

- Shared mailboxes with credential + collaborative inbox (Model B) — deferred to issue #13.
- Phase 3 (Sieve filters UI + auto-replies) and Phase 4 (Odoo modules).
- Admin management of group addresses in-app — not needed: groups derive from Stalwart-configured identities.
