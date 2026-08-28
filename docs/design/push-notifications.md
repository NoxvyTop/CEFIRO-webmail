# Push notifications for new mail (#294)

Status: **design approved (owner)** — build pending. No Firebase.

## Decision & scope

- **Delivery: Web Push (VAPID).** The W3C/IETF standard push channel. We generate our
  own VAPID key pair (no account, no Firebase — same posture as `MASTER_KEY`) and the
  server pushes directly to each browser's push endpoint with the `web-push` protocol.
  Owner rejected FCM/Firebase explicitly.
- **Trigger: Stalwart webhook** (`store.ingest`), HMAC-signed. Fallback: a server-side
  per-user JMAP EventSource worker (see Trigger below). **Built (GH #337):** the fallback
  shape, on the stream the SPA already holds — `modules/push/new-mail.ts`, tapped from
  `GET /api/mail/events`. It therefore covers a session with a tab open; a server-held
  connection (or the webhook, once its payload spike lands) is what extends it to a
  closed app.
- **Surfaces in scope:** desktop and mobile browsers, and the **installed PWA**
  ("Add to Home Screen"). This is how privacy-first webmail (Proton, Tuta) does it.
- **Deferred:** background push inside the native Capacitor thin-shell APK. Android
  System WebView has no background Web Push; the no-Google path there is UnifiedPush/ntfy,
  tracked as a later, separate effort (not this issue).
- **Opt-in, inert until configured** — mirrors the AI feature: with no VAPID keys the
  `PushSender` is a null adapter and nothing is offered in the UI.

## Two layers (do not conflate)

1. **Detection** — the server learns a message was delivered to a local account.
2. **Delivery** — the notification reaches the device even with the app closed.

A webhook only does (1). (2) requires an OS/browser push channel — Web Push. Both are
Firebase-free.

## Detection (trigger)

**Primary — Stalwart webhook.** Stalwart emits `store.ingest` on message ingestion and can
POST it to a Céfiro endpoint, authenticated with an HMAC `X-Signature` (config
`signatureKey`) or a Bearer token (`httpAuth`). Céfiro verifies the signature, maps the
event to the recipient user, looks up that user's push subscriptions, and sends.

**Open spike (blocking for the webhook path):** confirm the `store.ingest` payload carries
the **recipient account** (and ideally sender/subject) against the running Stalwart v0.16.
- If yes → use the webhook (one global receiver, no persistent connections). Cleanest.
- If the payload cannot identify the recipient → **fallback camino B: per-user EventSource
  worker.** For each user with an active subscription, the server holds a JMAP EventSource
  (using the already-stored `mailCredentials`) and reacts to `Email` `StateChange` frames
  via the existing `tapEmailStateChanges` helper. Each connection is authenticated as one
  user, so the identity is unambiguous — at the cost of one long-lived connection per
  subscribed user (acceptable at this scale).

Either way the **delivery** side below is identical, so it is built first.

## Delivery (Web Push / VAPID)

- **Keys:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` or URL).
  Self-generated (`web-push generate-vapid-keys`), stored like other secrets; absent →
  feature inert. Public key is exposed to the SPA to subscribe.
- **Send:** the `web-push` protocol (encrypted payload to the subscription endpoint, VAPID
  JWT auth). The endpoint host is the browser vendor's (Google/Mozilla/Apple) and is used
  transparently — **no vendor account required**.
- **Payload discipline (privacy):** never send the message body. Title = sender display
  name; body = subject truncated, or a generic "Tienes N correos nuevos" when batching.
  The SW fetches nothing sensitive; the push carries only what is shown.

## Data model

`push_subscriptions` (new table):
- `id`, `user_id` (fk), `endpoint` (unique), `p256dh`, `auth` (the subscription keys),
  `user_agent` (nullable, for the future "devices" UI, aligns with #302), `created_at`,
  `last_seen_at`.
- Revoked on `410 Gone`/`404` from the push service (subscription expired) and on user
  opt-out; ties into the session-hardening "devices" work (#302).

Preference: per-user opt-in flag (reuse the profile/settings store).

## Server pieces

- `PushSender` interface + `web-push` adapter, plus a **null adapter** when VAPID is
  unconfigured (same pattern as `aiClient`; `GET /api/push/status → {enabled}`).
- `POST /api/push/subscribe` / `DELETE /api/push/subscribe` — store/remove a
  `PushSubscription` for the session user.
- `GET /api/push/vapid-public-key` — hand the SPA the public key.
- `POST /api/push/hooks/stalwart` — the webhook receiver: verify `X-Signature`, map to
  user(s), compose, send. Rate-limited; body size-capped.
- Notification composition: minimal JMAP `Email/get` for the new id(s) to get
  sender+subject (title/body only), then `PushSender.send` to each subscription.

## Web pieces

- **Service worker** (`push`, `notificationclick`): show the notification, focus/open the
  thread on click. Icon and badge are PNG (GH #350): Android Chrome ignores an SVG icon,
  and `badge` is rendered as a monochrome mask. A push about a shared mailbox carries the
  account id and opens `/?account=<id>&thread=<id>` (GH #337).
- **Installed PWA** (GH #350): `public/manifest.webmanifest` (`display: standalone`, 192/512
  and maskable icons) plus a `theme-color` per scheme in `index.html`. The PNGs are generated
  from `public/favicon.svg`'s own geometry by `apps/web/scripts/generate-pwa-icons.mjs` — no
  image dependency; the output is committed and the script is re-run only when the mark
  changes. `registerPushServiceWorker` also calls `registration.update()` so a fixed worker
  reaches an installed PWA on the next load rather than on the browser's own schedule.
- Subscribe flow: request `Notification` permission (only on an explicit user gesture —
  a "Activar notificaciones" toggle in settings, never on load), `PushManager.subscribe`
  with the VAPID public key, POST the subscription.
- Opt-in UI in settings + an unsubscribe path. Hidden entirely when `push/status` is off.

## Security / privacy

- Webhook authenticated (HMAC `X-Signature` verified with a shared `signatureKey`); reject
  otherwise. Endpoint is unauthenticated by session but signature-gated.
- No message body in the push payload. Subscriptions are per-user; revoked on expiry/opt-out.
- Permission requested only on explicit user action (Play/PWA and browser best practice).

## Build slices (chained toward the PR)

1. **Delivery scaffolding** (trigger-independent): VAPID config + null `PushSender`,
   `push_subscriptions` table, subscribe/unsubscribe + vapid-key + status endpoints,
   service worker, settings opt-in UI, `web-push` adapter. Testable with a manual send.
2. **Trigger**: the `store.ingest` payload spike, then the webhook receiver (or camino B
   worker) + notification composition.
3. **Polish**: batching/throttle, per-device list (folds into #302), quiet hours (future).

## Out of scope / follow-ups

- Native APK background push (UnifiedPush/ntfy) — later, separate.
- Quiet hours, per-mailbox rules — future.
