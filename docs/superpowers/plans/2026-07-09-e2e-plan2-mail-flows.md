# E2E Plan 2/2 — Ephemeral Stalwart + real mail flows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end coverage of the mail flows (mailboxes/inbox, read, compose+send, star, archive, labels) against a REAL, pre-provisioned, ephemeral Stalwart CE container — the mechanism proven in the spike. See `docs/superpowers/specs/2026-07-08-e2e-playwright-design.md`.

**Architecture:** A committed `e2e/stalwart/` fixture (Dockerfile `FROM stalwartlabs/stalwart:v0.16` + `entrypoint.sh` that seeds the config/data volumes from a baked `seed/` on first boot) yields a container that boots FULLY PROVISIONED (domain `cefiro.test`, internal directory, RocksDB, working JMAP) with fresh isolated state every run. `docker-compose.e2e.yml` runs Postgres + this Stalwart. Playwright's webServer builds+serves the app pointed at the Stalwart container (`STALWART_URL`). `global-setup.ts` seeds a webmail user whose email + encrypted mailbox credential match the Stalwart account, then injects a few inbox emails via a plain-socket SMTP conversation (local delivery to `cefiro.test`).

**Tech Stack:** existing + Docker Compose for the test stack. No app/server source changes.

## Proven facts from the spike (use verbatim)

- Image: `stalwartlabs/stalwart:v0.16` (0.16.12). Fixture at `e2e/stalwart/` (Dockerfile, entrypoint.sh, seed/ ≈1.7M = config.json + RocksDB). Building it and running fresh (no volumes) → normal mode + JMAP.
- Test mail account (baked in): **`admin@cefiro.test`** / **`n2BODWVsupeXnJ3L`**, domain `cefiro.test`, hostname `mail.cefiro.test`, no TLS.
- JMAP: `GET /.well-known/jmap` (Basic auth `email:password`) → 307 → `/jmap/session` returns capabilities incl. `urn:ietf:params:jmap:mail`. This is exactly what the app's JMAP client uses.
- The base image declares `/etc/stalwart` and `/var/lib/stalwart` as VOLUMEs — that is WHY the seed+entrypoint pattern exists (do not "simplify" to a plain COPY or docker commit; both are discarded/skipped).
- Server serves the SPA only with `NODE_ENV=production` + `STATIC_DIR`; migrates on boot. Session cookie `session=<token>` via `createSessionStore.create`. Mailbox credential: `createMailCredentialsRepo(sql, key).set(userId, password)` with `key = await importMasterKey(<base64>)`.

## Global Constraints

- English code/identifiers/comments/commits; conventional commits; no AI attribution.
- **Zero app/server source changes** — the harness is self-contained. If a spec needs a source change, STOP and escalate.
- The `e2e/stalwart/seed/` binary (RocksDB) IS committed on purpose (synthetic test data — domain `cefiro.test`, a test account; NO real noxvytop data). Do NOT gitignore it. It contains only fixture data; the baked `n2BODWVsupeXnJ3L` is a known test credential like the dev MASTER_KEY.
- **NEVER kill processes globally** (no taskkill /IM, pkill). Manage the test Stalwart ONLY via `docker compose -f docker-compose.e2e.yml up/down` (or the single container by name). Never touch the dev container (Postgres 5434) or the user's production Stalwart.
- Selectors: role + accessible name + the rendered es strings.
- Local ports (host): Stalwart JMAP `8096`, Stalwart SMTP `8025`, app `8199` (8080=Odoo, 8090=dev API, 8095 was the spike — all avoided). Postgres for the app: reuse the dev container's `5434` locally, CI `5432`.
- Branch: `init-e2e-mail`.

---

### Task 1: Commit the Stalwart fixture + compose stack

**Files:**
- Add (already on disk, untracked): `e2e/stalwart/Dockerfile`, `e2e/stalwart/entrypoint.sh`, `e2e/stalwart/seed/**`
- Create: `e2e/stalwart/README.md`, `docker-compose.e2e.yml`
- Modify: root `.gitignore` (ensure `e2e/stalwart/seed` is NOT ignored; the earlier `e2e/…` ignores were for `.auth`/`test-results`/`playwright-report`/`node_modules` — confirm none match `e2e/stalwart`)

- [ ] **Step 1: README** — `e2e/stalwart/README.md` documenting: what this is (a pre-provisioned Stalwart CE test fixture), how it was made (setup wizard once → extracted config+RocksDB into `seed/` → entrypoint seeds the VOLUME dirs on first boot because the base image declares them as volumes), the baked account (`admin@cefiro.test` / `n2BODWVsupeXnJ3L`, domain `cefiro.test`), and how to rebuild if Stalwart is bumped (re-run the wizard, re-extract). English.

- [ ] **Step 2: docker-compose.e2e.yml** at the repo root:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: webmail
      POSTGRES_PASSWORD: webmail
      POSTGRES_DB: webmail
    ports:
      - "5435:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U webmail"]
      interval: 5s
      timeout: 5s
      retries: 10

  stalwart:
    build: ./e2e/stalwart
    ports:
      - "8096:8080"
      - "8025:25"
    healthcheck:
      test: ["CMD", "/usr/local/bin/stalwart", "--version"]
      interval: 5s
      timeout: 5s
      retries: 20
```

(Local runs reuse the dev Postgres on 5434; this compose Postgres on 5435 is for a fully self-contained `docker compose` run and for CI. The plan's playwright config DATABASE_URL selects per environment — document it. If keeping two Postgres sources is confusing, the implementer may drop the compose postgres and rely on the dev/CI Postgres, keeping ONLY the stalwart service here — choose the simpler wiring that runs green and document it.)

- [ ] **Step 3: Verify** — `docker compose -f docker-compose.e2e.yml up -d --build` (uses the local image build). Wait for stalwart healthy. Then `curl -s -u 'admin@cefiro.test:n2BODWVsupeXnJ3L' -L http://localhost:8096/.well-known/jmap` returns JMAP capabilities (contains `urn:ietf:params:jmap:mail`). Then `docker compose -f docker-compose.e2e.yml down`. Capture the curl output in the report. NEVER global-kill; use compose down.

- [ ] **Step 4: Commit** — `test(e2e): pre-provisioned stalwart fixture and compose stack`

---

### Task 2: Mail wiring — STALWART_URL, seeded mailbox credential, SMTP inbox seed

**Files:**
- Modify: `e2e/playwright.config.ts` (webServer env gets `STALWART_URL`), `e2e/global-setup.ts` (seed mailbox credential + inbox emails)
- Create: `e2e/smtp-seed.ts` (a tiny plain-socket SMTP client), `e2e/fixtures/mail.ts` (the seed email fixtures)
- Test: `e2e/tests/mail-connect.spec.ts`

**Interfaces / behavior:**

- playwright.config webServer.env adds `STALWART_URL: process.env.E2E_STALWART_URL ?? "http://localhost:8096"`. (The app's JMAP client reads `STALWART_URL`; when set, `config.stalwartUrl` is truthy and the mail router is live.)

- The webServer must NOT auto-manage Stalwart; the compose stack is brought up SEPARATELY (locally by the developer / by the CI job before playwright). Document that `docker compose -f docker-compose.e2e.yml up -d --build` must run before the mail specs. Optionally, `global-setup.ts` may check Stalwart reachability (a fetch to `${STALWART_URL}/.well-known/jmap`) and fail with a clear message if it's down.

- `global-setup.ts` — in addition to the slice-1 seeding (admin webmail user + session storageState), when `STALWART_URL` is set:
  - Change the seeded webmail user's email to **`admin@cefiro.test`** (so it matches the Stalwart account; JMAP Basic auth uses the user's email).
  - Store the encrypted mailbox credential: `const key = await importMasterKey("ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE="); await createMailCredentialsRepo(sql, key).set(user.id, "n2BODWVsupeXnJ3L");` (relative-import these from apps/server/src like the existing globalSetup imports).
  - Seed inbox emails: call `seedInbox()` from `smtp-seed.ts` with the fixtures, delivering to `admin@cefiro.test` via SMTP on `localhost:8025`.

- `e2e/smtp-seed.ts` — a minimal SMTP sender over a raw TCP socket (Node `net` / `Bun.connect`), NO new dependency. It runs a plain SMTP conversation to inject inbound local mail:
  ```
  connect localhost:8025 → read 220
  EHLO cefiro.test → read 250-...
  MAIL FROM:<seed@example.org> → 250
  RCPT TO:<admin@cefiro.test> → 250   (local domain, accepted as inbound delivery)
  DATA → 354
  <raw RFC822 message with From/To/Subject/Date/Message-ID + body> .CRLF → 250
  QUIT
  ```
  Export `async function seedInbox(host: string, port: number, messages: SeedEmail[]): Promise<void>`. Retry the connect a few times (Stalwart SMTP may take a moment). If Stalwart rejects unauthenticated local delivery on port 25 (check the 250/550 codes), fall back to the submission port with the test account's credentials (AUTH LOGIN admin@cefiro.test / n2BODWVsupeXnJ3L) — document which worked.

- `e2e/fixtures/mail.ts` — 3 deterministic seed emails (distinct senders/subjects/bodies, one with a label-ish keyword is NOT needed here; keep them plain), e.g. from `carla@partner.test` / `lucia@partner.test` / `marc@partner.test`, with fixed subjects the specs assert on.

- `e2e/tests/mail-connect.spec.ts` (authenticated): the app connects to Stalwart — the message list is NOT the "mail not configured" error; the seeded inbox shows at least the 3 seeded subjects; opening one shows its body in the reading pane.

- [ ] **Step 1** write the SMTP seeder + fixtures. **Step 2** wire config + globalSetup. **Step 3** bring up the compose stack, run `cd e2e && bunx playwright test tests/mail-connect.spec.ts` GREEN (real browser → app → JMAP → Stalwart). Iterate on the SMTP conversation against the running container until the seeded mail actually appears. **Step 4** commit — `test(e2e): stalwart mail wiring, credential and smtp inbox seed`.

---

### Task 3: Mail-flow specs

**Files:** `e2e/tests/mail-read.spec.ts`, `e2e/tests/mail-compose.spec.ts`, `e2e/tests/mail-actions.spec.ts`

All authenticated, against the seeded inbox. Behaviors (write real specs; iterate against the live stack):

- **mail-read.spec**: the inbox lists the seeded subjects in order; clicking one opens the reading pane with the sender + body; the message is marked read (unread dot gone / weight change).
- **mail-compose.spec**: click Redactar → composer opens with a real identity (`admin@cefiro.test`) in From; fill To (`admin@cefiro.test` — self, so it lands locally), Subject, body; Send → the "Correo enviado" toast; the sent message appears in the Sent mailbox (navigate to Sent, find the subject). (Self-send keeps it fully local; Stalwart delivers to the same account's Inbox too — either assertion is fine, pick the deterministic one.)
- **mail-actions.spec**: on a seeded message — Star it (row star), then the Destacados view shows it; Archive it from the reader → it leaves the inbox and the archive mailbox/Archivados shows it. (Labels require a user keyword on a message; SKIP labels here unless a seeded message carries one — if you want label coverage, add a keyword to one seed email via JMAP in globalSetup and assert the sidebar chip; otherwise note labels as covered by the unit/component suite and out of this slice.)

- [ ] RED where practical (a spec fails before its feature path is exercised is hard for E2E — instead, assert the real post-conditions and iterate to green). Full mail suite green against the live stack. Commit — `test(e2e): read, compose-send, star and archive flows`.

---

### Task 4: CI — bring up the compose stack in the e2e job

**Files:** Modify `.github/workflows/ci.yml`

In the existing `e2e` job (from slice 1), before the playwright run, bring up the Stalwart+compose stack and point the app at it:
- Add a step: `docker compose -f docker-compose.e2e.yml up -d --build` then wait for stalwart healthy (a loop cur\'ing `/.well-known/jmap` or `docker compose ... ps` health).
- The playwright step gets env `E2E_STALWART_URL: http://localhost:8096` (and keep `DATABASE_URL` pointing at the CI Postgres service; the compose Postgres on 5435 is unused in CI unless the implementer chose to consolidate — keep whichever Task 1 settled on).
- Add a final `if: always()` step: `docker compose -f docker-compose.e2e.yml down -v` to clean up.
- The GitHub runner has Docker + compose; the stalwart image builds from `e2e/stalwart` (COPY of the committed seed) — no registry needed.

- [ ] Verify the YAML structurally (read it back). Commit — `ci: run mail e2e against ephemeral stalwart`.

---

### Task 5: Verification sweep

- [ ] `docker compose -f docker-compose.e2e.yml up -d --build`; `cd e2e && bunx playwright test` — ALL e2e specs green (slice-1 mail-independent + slice-2 mail flows); `docker compose -f docker-compose.e2e.yml down -v`.
- [ ] Root `bun run typecheck` clean (incl. e2e); root `bun run test` — unit suites green, e2e not picked up.
- [ ] `bun install --frozen-lockfile` consistent.
- [ ] Report counts; commit only if fixes were needed.
