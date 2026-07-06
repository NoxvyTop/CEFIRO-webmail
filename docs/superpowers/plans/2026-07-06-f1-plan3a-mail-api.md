# F1 Plan 3a/4 — Mail API (JMAP proxy to Stalwart)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticated employees can read their Stalwart mailbox through typed BFF endpoints: mailbox list, message list with pagination and search, full thread detail, label/read/move updates, and an SSE bridge for real-time change notifications.

**Architecture:** The BFF talks JMAP to Stalwart using each user's decrypted mailbox credential (Basic auth). The browser never speaks JMAP — it consumes typed REST-ish endpoints validated by shared Zod contracts. JMAP method chaining (`Email/query` + back-referenced `Email/get`) keeps round-trips to one HTTP request. The JMAP session (apiUrl, accountId, eventSourceUrl) is cached in memory per user. Push: the BFF pipes Stalwart's JMAP EventSource stream to the browser over SSE. See `docs/ARCHITECTURE.md`.

**Tech Stack:** existing stack; no new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; conventional commits; no AI attribution; no compiled .js committed.
- TDD per task: failing output captured, then passing; both in the report.
- Runtime-agnostic: Web APIs only (fetch, streams); Bun-only APIs confined to `src/index.ts`.
- Mailbox credentials never logged, never in error envelopes, never in test fixtures with real values.
- Mail content is NEVER audited or logged (privacy) — no audit entries in this plan.
- `STALWART_URL` is optional config: when absent, mail endpoints return 503 `{ code: "mail_not_configured", message: "errors.mail_not_configured" }` — the dev machine has no reachable Stalwart; all tests use a stubbed JMAP client or stubbed fetch.
- Postgres for integration tests on host port 5434 (fallback `postgres://webmail:webmail@localhost:5434/webmail`).
- NEVER kill processes globally.
- Branch: `init-mail-api`.

---

### Task 1: Shared mail contracts

**Files:**
- Create: `packages/shared/src/api/mail.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./api/mail";`)
- Test: `packages/shared/src/api/mail.test.ts`

**Interfaces (produces):**

```ts
import { z } from "zod";

export const mailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  role: z.string().nullable(),
  sortOrder: z.number(),
  unreadEmails: z.number(),
  totalEmails: z.number(),
});
export type Mailbox = z.infer<typeof mailboxSchema>;

export const emailAddressSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});
export type EmailAddress = z.infer<typeof emailAddressSchema>;

export const emailSummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  mailboxIds: z.array(z.string()),
  from: z.array(emailAddressSchema),
  to: z.array(emailAddressSchema),
  subject: z.string(),
  receivedAt: z.string(),
  preview: z.string(),
  keywords: z.record(z.string(), z.boolean()),
  hasAttachment: z.boolean(),
  size: z.number(),
});
export type EmailSummary = z.infer<typeof emailSummarySchema>;

export const messagesPageSchema = z.object({
  total: z.number(),
  position: z.number(),
  emails: z.array(emailSummarySchema),
});
export type MessagesPage = z.infer<typeof messagesPageSchema>;

export const attachmentMetaSchema = z.object({
  blobId: z.string(),
  name: z.string().nullable(),
  type: z.string(),
  size: z.number(),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

export const emailDetailSchema = emailSummarySchema.extend({
  cc: z.array(emailAddressSchema),
  replyTo: z.array(emailAddressSchema),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  attachments: z.array(attachmentMetaSchema),
});
export type EmailDetail = z.infer<typeof emailDetailSchema>;

export const threadDetailSchema = z.object({
  id: z.string(),
  emails: z.array(emailDetailSchema),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const emailUpdateSchema = z
  .object({
    keywords: z.record(z.string(), z.boolean()).optional(),
    mailboxIds: z.record(z.string(), z.boolean()).optional(),
  })
  .refine((v) => v.keywords !== undefined || v.mailboxIds !== undefined, {
    message: "at least one of keywords or mailboxIds is required",
  });
export type EmailUpdate = z.infer<typeof emailUpdateSchema>;
```

- [ ] **Step 1: Write the failing test** — `packages/shared/src/api/mail.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  emailSummarySchema,
  emailUpdateSchema,
  mailboxSchema,
  threadDetailSchema,
} from "./mail";

describe("mail contracts", () => {
  it("accepts a valid mailbox", () => {
    const parsed = mailboxSchema.parse({
      id: "mb1",
      name: "Inbox",
      parentId: null,
      role: "inbox",
      sortOrder: 0,
      unreadEmails: 3,
      totalEmails: 10,
    });
    expect(parsed.role).toBe("inbox");
  });

  it("accepts a valid email summary", () => {
    const parsed = emailSummarySchema.parse({
      id: "e1",
      threadId: "t1",
      mailboxIds: ["mb1"],
      from: [{ name: "Ana", email: "ana@noxvytop.com" }],
      to: [{ name: null, email: "b@noxvytop.com" }],
      subject: "Hello",
      receivedAt: "2026-07-06T10:00:00Z",
      preview: "Hi there",
      keywords: { $seen: true },
      hasAttachment: false,
      size: 1234,
    });
    expect(parsed.keywords.$seen).toBe(true);
  });

  it("accepts a thread with html-only and text-only emails", () => {
    const email = {
      id: "e1",
      threadId: "t1",
      mailboxIds: ["mb1"],
      from: [],
      to: [],
      subject: "",
      receivedAt: "2026-07-06T10:00:00Z",
      preview: "",
      keywords: {},
      hasAttachment: true,
      size: 10,
      cc: [],
      replyTo: [],
      bodyHtml: "<p>hi</p>",
      bodyText: null,
      attachments: [{ blobId: "b1", name: "a.pdf", type: "application/pdf", size: 99 }],
    };
    const parsed = threadDetailSchema.parse({ id: "t1", emails: [email] });
    expect(parsed.emails[0]?.attachments[0]?.name).toBe("a.pdf");
  });

  it("rejects an empty email update", () => {
    expect(() => emailUpdateSchema.parse({})).toThrow();
    expect(emailUpdateSchema.parse({ keywords: { $seen: true } }).keywords).toEqual({
      $seen: true,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`bunx vitest run` in packages/shared) — cannot resolve `./mail`.
- [ ] **Step 3: Implement** `mail.ts` exactly as the Interfaces block above; add the index export.
- [ ] **Step 4: Run to verify it passes** (existing envelope tests stay green); `bun run typecheck` in packages/shared.
- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add mail api contracts"
```

---

### Task 2: JMAP client infrastructure

**Files:**
- Create: `apps/server/src/infra/stalwart/jmap.ts`
- Modify: `apps/server/src/core/config.ts` (add optional `stalwartUrl` from `STALWART_URL`)
- Test: `apps/server/src/infra/stalwart/jmap.test.ts`, extend `apps/server/src/core/config.test.ts`

**Interfaces (produces):**

```ts
export type JmapAuth = { email: string; password: string };
export type JmapSession = {
  apiUrl: string;
  accountId: string;
  eventSourceUrl: string;
};
export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapMethodResponse = [string, Record<string, unknown>, string];

export function createJmapClient(input: {
  baseUrl: string;
  fetchFn?: typeof fetch;
}): {
  getSession(auth: JmapAuth): Promise<JmapSession>;
  request(auth: JmapAuth, session: JmapSession, calls: JmapMethodCall[]): Promise<JmapMethodResponse[]>;
};
export type JmapClient = ReturnType<typeof createJmapClient>;
```

Contract details:
- `getSession`: GET `${baseUrl}/.well-known/jmap` with `authorization: Basic base64(email:password)`, `accept: application/json`. Non-ok 401 → `DomainError("mail_auth_failed", 502, "errors.mail_auth_failed")`; other non-ok → `DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable")`. Maps `{ apiUrl, eventSourceUrl, primaryAccounts["urn:ietf:params:jmap:mail"] }` → accountId; missing account → `stalwart_unavailable` error.
- `request`: POST `session.apiUrl` with body `{ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls }`, same Basic header. Non-ok → same error mapping. Returns `body.methodResponses`. If a response tuple's name is `"error"` → `DomainError("jmap_error", 502, "errors.jmap_error")`.
- Config: `stalwartUrl: z.string().url().optional()` fed from `env.STALWART_URL` (empty string → undefined).

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/core/config.test.ts`:

```ts
  it("parses optional STALWART_URL and treats empty as undefined", () => {
    expect(loadConfig(validEnv).stalwartUrl).toBeUndefined();
    expect(loadConfig({ ...validEnv, STALWART_URL: "" }).stalwartUrl).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, STALWART_URL: "https://mail.noxvytop.com" }).stalwartUrl,
    ).toBe("https://mail.noxvytop.com");
  });
```

`apps/server/src/infra/stalwart/jmap.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createJmapClient, type JmapSession } from "./jmap";

const auth = { email: "u@noxvytop.com", password: "mailbox-pw" };
const sessionBody = {
  apiUrl: "https://mail.test/jmap/",
  eventSourceUrl: "https://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
};

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("jmap client", () => {
  it("fetches the session with basic auth and maps fields", async () => {
    const fetchFn = fetchReturning(sessionBody);
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
    const session = await client.getSession(auth);
    expect(session.accountId).toBe("acc-1");
    expect(session.apiUrl).toBe("https://mail.test/jmap/");
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("https://mail.test/.well-known/jmap");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa("u@noxvytop.com:mailbox-pw")}`,
    );
  });

  it("maps 401 to mail_auth_failed", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning({}, 401),
    });
    await expect(client.getSession(auth)).rejects.toMatchObject({
      code: "mail_auth_failed",
    });
  });

  it("posts method calls and returns methodResponses", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ methodResponses: [["Mailbox/get", { list: [] }, "0"]] }),
      ),
    ) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
    };
    const responses = await client.request(auth, session, [
      ["Mailbox/get", { accountId: "acc-1" }, "0"],
    ]);
    expect(responses[0]?.[0]).toBe("Mailbox/get");
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.using).toContain("urn:ietf:params:jmap:mail");
    expect(body.methodCalls[0][0]).toBe("Mailbox/get");
  });

  it("maps a jmap error response tuple to jmap_error", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning({
        methodResponses: [["error", { type: "serverFail" }, "0"]],
      }),
    });
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
    };
    await expect(
      client.request(auth, session, [["Mailbox/get", {}, "0"]]),
    ).rejects.toMatchObject({ code: "jmap_error" });
  });
});
```

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** — `apps/server/src/infra/stalwart/jmap.ts`:

```ts
import { DomainError } from "../../core/errors";

export type JmapAuth = { email: string; password: string };
export type JmapSession = {
  apiUrl: string;
  accountId: string;
  eventSourceUrl: string;
};
export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapMethodResponse = [string, Record<string, unknown>, string];

function basicAuth(auth: JmapAuth): string {
  return `Basic ${btoa(`${auth.email}:${auth.password}`)}`;
}

function toDomainError(status: number): DomainError {
  if (status === 401) {
    return new DomainError("mail_auth_failed", 502, "errors.mail_auth_failed");
  }
  return new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
}

export function createJmapClient(input: {
  baseUrl: string;
  fetchFn?: typeof fetch;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");

  return {
    async getSession(auth: JmapAuth): Promise<JmapSession> {
      const res = await fetchFn(`${baseUrl}/.well-known/jmap`, {
        headers: { authorization: basicAuth(auth), accept: "application/json" },
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as {
        apiUrl?: string;
        eventSourceUrl?: string;
        primaryAccounts?: Record<string, string>;
      };
      const accountId = body.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (!body.apiUrl || !accountId) {
        throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
      }
      return {
        apiUrl: body.apiUrl,
        accountId,
        eventSourceUrl: body.eventSourceUrl ?? "",
      };
    },

    async request(
      auth: JmapAuth,
      session: JmapSession,
      calls: JmapMethodCall[],
    ): Promise<JmapMethodResponse[]> {
      const res = await fetchFn(session.apiUrl, {
        method: "POST",
        headers: {
          authorization: basicAuth(auth),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
          methodCalls: calls,
        }),
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as { methodResponses: JmapMethodResponse[] };
      for (const [name] of body.methodResponses) {
        if (name === "error") {
          throw new DomainError("jmap_error", 502, "errors.jmap_error");
        }
      }
      return body.methodResponses;
    },
  };
}

export type JmapClient = ReturnType<typeof createJmapClient>;
```

Config change in `loadConfig`: add to the parse input `stalwartUrl: env.STALWART_URL || undefined,` and to the schema `stalwartUrl: z.string().url().optional(),`.

- [ ] **Step 4: Run to verify green** (whole server suite + typecheck).
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/infra/stalwart apps/server/src/core
git commit -m "feat(server): add jmap client and optional stalwart url config"
```

---

### Task 3: Mail context + mailboxes endpoint

**Files:**
- Create: `apps/server/src/modules/mail/context.ts`, `apps/server/src/modules/mail/router.ts`
- Modify: `apps/server/src/app.ts` (add `mailRouter` option mounted at `/api/mail`)
- Test: `apps/server/src/modules/mail/mailboxes.test.ts`

**Interfaces (produces):**

```ts
// context.ts
export type MailDeps = {
  sessions: SessionStore;
  mailCredentials: MailCredentialsRepo;
  jmap: JmapClient | null;          // null when STALWART_URL is not configured
};
export type MailVariables = AuthVariables & {
  jmapAuth: JmapAuth;
  jmapSession: JmapSession;
};
export function requireMail(deps: MailDeps): MiddlewareHandler<{ Variables: MailVariables }>;
```

Contract: `requireMail` chains after `requireSession` logic (calls the same session lookup via `deps.sessions` — implement by composing: the router applies `requireSession(deps.sessions)` first, then `requireMail`). `requireMail` itself: `deps.jmap === null` → 503 `mail_not_configured`; `mailCredentials.get(user.userId)` null → 503 `{ code: "mail_credentials_missing", message: "errors.mail_credentials_missing" }`; otherwise builds `jmapAuth = { email: user.email, password }`, fetches `jmapSession` via an in-memory per-user cache (Map keyed by userId, TTL 5 minutes — store `{ session, fetchedAt }`), sets both context vars.

```ts
// router.ts
export function createMailRouter(deps: MailDeps) // GET /mailboxes in this task
```

`GET /mailboxes`: one JMAP call `[["Mailbox/get", { accountId, properties: ["id","name","parentId","role","sortOrder","unreadEmails","totalEmails"] }, "0"]]` → map list to `Mailbox[]` (missing `parentId`/`role` → null, missing numbers → 0), sorted by `sortOrder` ascending, `c.json(mailboxes)`.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/mail/mailboxes.test.ts` (integration: real Postgres for session/credential; stubbed JmapClient):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

const stubJmap: JmapClient = {
  getSession: async () => ({
    apiUrl: "https://mail.test/jmap/",
    accountId: "acc-1",
    eventSourceUrl: "https://mail.test/es",
  }),
  request: async () => [
    [
      "Mailbox/get",
      {
        list: [
          { id: "mb2", name: "Sent", parentId: null, role: "sent", sortOrder: 2, unreadEmails: 0, totalEmails: 5 },
          { id: "mb1", name: "Inbox", role: "inbox", sortOrder: 1, unreadEmails: 3, totalEmails: 10 },
        ],
      },
      "0",
    ],
  ],
};

let sessions: ReturnType<typeof createSessionStore>;
let token: string;
let tokenNoCred: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  const creds = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);

  const withCred = await users.create({
    email: `m-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Mail User",
  });
  await creds.set(withCred.id, "mailbox-pw");
  token = (await sessions.create(withCred.id, 1)).token;

  const withoutCred = await users.create({
    email: `nc-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "No Cred",
  });
  tokenNoCred = (await sessions.create(withoutCred.id, 1)).token;

  globalThis.__mailApp = (jmap: JmapClient | null) =>
    createApp({
      mailRouter: createMailRouter({ sessions, mailCredentials: creds, jmap }),
    });
});
afterAll(() => sql.end());

declare global {
  // eslint-disable-next-line no-var
  var __mailApp: (jmap: JmapClient | null) => ReturnType<typeof createApp>;
}

describe("GET /api/mail/mailboxes", () => {
  it("requires a session", async () => {
    const res = await globalThis.__mailApp(stubJmap).request("/api/mail/mailboxes");
    expect(res.status).toBe(401);
  });

  it("returns 503 when stalwart is not configured", async () => {
    const res = await globalThis.__mailApp(null).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("mail_not_configured");
  });

  it("returns 503 when the user has no mail credential", async () => {
    const res = await globalThis.__mailApp(stubJmap).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${tokenNoCred}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("mail_credentials_missing");
  });

  it("maps and sorts mailboxes", async () => {
    const res = await globalThis.__mailApp(stubJmap).request("/api/mail/mailboxes", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; parentId: string | null }>;
    expect(body.map((m) => m.id)).toEqual(["mb1", "mb2"]);
    expect(body[0]?.parentId).toBeNull();
  });
});
```

(If the `globalThis.__mailApp` helper feels awkward, a plain local `function makeApp(jmap)` is equally acceptable — the assertions are what matter.)

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** context middleware, router (GET /mailboxes with the exact JMAP call from the contract), and the `mailRouter` mount in `app.ts` (`if (options.mailRouter) app.route("/api/mail", options.mailRouter as never);`).

`context.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/stalwart/jmap";
import type { SessionStore } from "../auth/sessions";
import type { AuthVariables } from "../auth/middleware";

export type MailDeps = {
  sessions: SessionStore;
  mailCredentials: MailCredentialsRepo;
  jmap: JmapClient | null;
};

export type MailVariables = AuthVariables & {
  jmapAuth: JmapAuth;
  jmapSession: JmapSession;
};

const SESSION_CACHE_TTL_MS = 5 * 60_000;
const sessionCache = new Map<string, { session: JmapSession; fetchedAt: number }>();

export function requireMail(
  deps: MailDeps,
): MiddlewareHandler<{ Variables: MailVariables }> {
  return async (c, next) => {
    if (!deps.jmap) {
      return c.json(
        { code: "mail_not_configured", message: "errors.mail_not_configured", traceId: c.get("traceId") },
        503,
      );
    }
    const user = c.get("user");
    const password = await deps.mailCredentials.get(user.userId);
    if (password === null) {
      return c.json(
        { code: "mail_credentials_missing", message: "errors.mail_credentials_missing", traceId: c.get("traceId") },
        503,
      );
    }
    const auth: JmapAuth = { email: user.email, password };
    const cached = sessionCache.get(user.userId);
    let session: JmapSession;
    if (cached && Date.now() - cached.fetchedAt < SESSION_CACHE_TTL_MS) {
      session = cached.session;
    } else {
      session = await deps.jmap.getSession(auth);
      sessionCache.set(user.userId, { session, fetchedAt: Date.now() });
    }
    c.set("jmapAuth", auth);
    c.set("jmapSession", session);
    await next();
  };
}
```

`router.ts` (this task's scope):

```ts
import { Hono } from "hono";
import type { Mailbox } from "@webmail/shared";
import { requireSession } from "../auth/middleware";
import { requireMail, type MailDeps, type MailVariables } from "./context";

type JmapMailbox = {
  id: string;
  name: string;
  parentId?: string | null;
  role?: string | null;
  sortOrder?: number;
  unreadEmails?: number;
  totalEmails?: number;
};

export function createMailRouter(deps: MailDeps) {
  const router = new Hono<{ Variables: MailVariables }>();

  router.use("*", requireSession(deps.sessions));
  router.use("*", requireMail(deps));

  router.get("/mailboxes", async (c) => {
    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      [
        "Mailbox/get",
        {
          accountId: session.accountId,
          properties: ["id", "name", "parentId", "role", "sortOrder", "unreadEmails", "totalEmails"],
        },
        "0",
      ],
    ]);
    const list = (responses[0]?.[1].list ?? []) as JmapMailbox[];
    const mailboxes: Mailbox[] = list
      .map((m) => ({
        id: m.id,
        name: m.name,
        parentId: m.parentId ?? null,
        role: m.role ?? null,
        sortOrder: m.sortOrder ?? 0,
        unreadEmails: m.unreadEmails ?? 0,
        totalEmails: m.totalEmails ?? 0,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return c.json(mailboxes);
  });

  return router;
}

export type MailRouter = ReturnType<typeof createMailRouter>;
```

- [ ] **Step 4: Run to verify green** (full suite + typecheck).
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/mail apps/server/src/app.ts
git commit -m "feat(server): add mail context and mailboxes endpoint"
```

---

### Task 4: Message list with pagination and search

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `GET /messages`)
- Test: `apps/server/src/modules/mail/messages.test.ts`

**Contract:** `GET /api/mail/messages?mailboxId=<id>&position=<n>&limit=<n>&query=<text>`
- `mailboxId` required → 400 `{ code: "invalid_query", message: "errors.invalid_query" }` when missing.
- `position` default 0, `limit` default 50 max 100 (clamp), `query` optional full-text.
- One chained JMAP request:

```ts
[
  ["Email/query", {
    accountId,
    filter: query ? { inMailbox: mailboxId, text: query } : { inMailbox: mailboxId },
    sort: [{ property: "receivedAt", isAscending: false }],
    position, limit, calculateTotal: true,
  }, "q"],
  ["Email/get", {
    accountId,
    "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
    properties: ["id","threadId","mailboxIds","from","to","subject","receivedAt","preview","keywords","hasAttachment","size"],
  }, "g"],
]
```

- Response `MessagesPage`: `total` from the `Email/query` response (`total ?? 0`), `position` from it, `emails` mapped from the `Email/get` list — keep JMAP's query order (the `Email/get` list order may differ; reorder by the query's `ids` array). Mapping defaults: `subject ?? ""`, `preview ?? ""`, `from/to ?? []` (map address objects `{ name: name ?? null, email }`), `keywords ?? {}`, `hasAttachment ?? false`, `size ?? 0`, `mailboxIds` object → array of keys with true.

- [ ] **Step 1: Write the failing test** — `apps/server/src/modules/mail/messages.test.ts`. Reuse the Task 3 test scaffolding (Postgres user + credential + session token; local `makeApp(jmap)` helper). Stub jmap `request` capturing `calls` for assertions and returning:

```ts
[
  ["Email/query", { ids: ["e2", "e1"], total: 2, position: 0 }, "q"],
  ["Email/get", {
    list: [
      { id: "e1", threadId: "t1", mailboxIds: { mb1: true }, from: [{ name: "Ana", email: "a@x.com" }], to: [], subject: "One", receivedAt: "2026-07-05T10:00:00Z", preview: "p1", keywords: { $seen: true }, hasAttachment: false, size: 10 },
      { id: "e2", threadId: "t2", mailboxIds: { mb1: true }, to: [{ email: "b@x.com" }], receivedAt: "2026-07-06T10:00:00Z", size: 20 },
    ],
  }, "g"],
]
```

Assertions:
1. Missing `mailboxId` → 400 `invalid_query`.
2. Happy path: 200; body parses with `messagesPageSchema` (import from @webmail/shared); `total` 2; emails ordered `["e2","e1"]` (query order, not get order); `e2` mapping defaults: `subject === ""`, `from` `[]`, `keywords` `{}`, `hasAttachment` false, `mailboxIds` `["mb1"]`.
3. The captured JMAP calls: `Email/query` filter equals `{ inMailbox: "mb1" }` without query param; with `&query=urgent` filter equals `{ inMailbox: "mb1", text: "urgent" }`; back-reference `#ids` present on the `Email/get` call.
4. `limit=500` is clamped: captured `limit` is 100.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the route per contract (reorder via `const order = new Map(ids.map((id, i) => [id, i]))`).
- [ ] **Step 4: Run to verify green** (full suite + typecheck).
- [ ] **Step 5: Commit** — `feat(server): add message list endpoint with pagination and search`

---

### Task 5: Thread detail endpoint

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `GET /threads/:threadId`)
- Test: `apps/server/src/modules/mail/threads.test.ts`

**Contract:** `GET /api/mail/threads/:threadId` — one chained request:

```ts
[
  ["Thread/get", { accountId, ids: [threadId] }, "t"],
  ["Email/get", {
    accountId,
    "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
    properties: ["id","threadId","mailboxIds","from","to","cc","replyTo","subject","receivedAt","preview","keywords","hasAttachment","size","htmlBody","textBody","bodyValues","attachments"],
    fetchHTMLBodyValues: true,
    fetchTextBodyValues: true,
    maxBodyValueBytes: 524288,
  }, "g"],
]
```

- Thread not found (`Thread/get` list empty) → 404 envelope `{ code: "not_found" }`.
- Mapping per email (extends Task 4 mapping): `cc`/`replyTo` like `from`; `bodyHtml` = concatenation of `bodyValues[part.partId].value` for each part in `htmlBody` (skip parts without a bodyValue), `null` when nothing; `bodyText` same over `textBody`; `attachments` = (`attachments ?? []`) mapped to `{ blobId, name: name ?? null, type: type ?? "application/octet-stream", size: size ?? 0 }`, skipping entries without `blobId`.
- Emails sorted by `receivedAt` ascending (oldest first — reading order).
- Response validates against `threadDetailSchema`.

- [ ] **Step 1: Write the failing test** — same scaffolding; stub returns a thread with two emails: one html-only (htmlBody 2 parts, both in bodyValues → concatenated), one text-only with one attachment; a later `receivedAt` on the first stub entry to prove re-sorting. Assert: 200 parses with `threadDetailSchema`; order oldest-first; `bodyHtml` concatenated correctly; text-only email has `bodyHtml === null`, `bodyText === "plain content"`; attachment mapped; unknown thread (stub `Thread/get` list `[]`) → 404.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement per contract.**
- [ ] **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add thread detail endpoint`

---

### Task 6: Message update endpoint (read/labels/move)

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `PATCH /messages/:id`)
- Test: `apps/server/src/modules/mail/update.test.ts`

**Contract:** `PATCH /api/mail/messages/:id`, body validated with `emailUpdateSchema` (400 `invalid_body` on failure, including malformed JSON — wrap `c.req.json()` in try/catch).
- JMAP patch semantics: for `keywords`, send per-key patches — `{ [`keywords/${key}`]: value === true ? true : null }` merged into one update object (JMAP removes a keyword when set to null). For `mailboxIds`, send the object as a FULL replacement `{ mailboxIds: body.mailboxIds }` (move semantics: the client sends the complete target set).
- Call: `[["Email/set", { accountId, update: { [id]: patch } }, "s"]]`.
- Response tuple `updated` contains the id (value may be null — that still means success) → 200 `{ ok: true }`. `notUpdated[id]` present → 409 `{ code: "update_failed", message: "errors.update_failed" }`.

- [ ] **Step 1: Write the failing test** — same scaffolding; stub captures calls. Cases: (1) `{ keywords: { "$seen": true, "label-x": false } }` → captured patch `{ "keywords/$seen": true, "keywords/label-x": null }`, 200; (2) `{ mailboxIds: { mb2: true } }` → captured `{ mailboxIds: { mb2: true } }`, 200; (3) stub returns `notUpdated: { e1: { type: "notFound" } }` → 409 `update_failed`; (4) empty body `{}` → 400 `invalid_body`; (5) malformed JSON body (`body: "{"`) → 400 `invalid_body`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement per contract.**
- [ ] **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add message update endpoint for read state, labels and moves`

---

### Task 7: SSE notifications bridge

**Files:**
- Modify: `apps/server/src/modules/mail/router.ts` (add `GET /events`)
- Test: `apps/server/src/modules/mail/events.test.ts`

**Contract:** `GET /api/mail/events` (guarded like all mail routes):
- Build the upstream URL from `jmapSession.eventSourceUrl` replacing placeholders: `{types}` → `Email,Mailbox`, `{closeafter}` → `no`, `{ping}` → `30` (plain `String.replaceAll`; if the URL has no placeholders, append nothing — use as-is).
- `fetchFn(upstreamUrl, { headers: { authorization: Basic..., accept: "text/event-stream" }, signal: c.req.raw.signal })` — the abort signal ties upstream lifetime to the client connection.
- Upstream non-ok or missing body → 502 envelope `{ code: "stalwart_unavailable" }`.
- Success → return `new Response(upstream.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } })` — direct passthrough, no buffering.
- The router needs access to a `fetchFn` for this route: extend `MailDeps` with `fetchFn?: typeof fetch` (default `fetch`).

- [ ] **Step 1: Write the failing test** — same scaffolding. Stub `fetchFn` returning `new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: state\ndata: {\"changed\":true}\n\n")); c.close(); } }), { status: 200 })`. Stub jmap session with `eventSourceUrl: "https://mail.test/es?types={types}&closeafter={closeafter}&ping={ping}"`. Assert: response 200 with `content-type: text/event-stream`; reading the body yields the enqueued chunk; the captured upstream URL equals `https://mail.test/es?types=Email,Mailbox&closeafter=no&ping=30`; upstream 500 → 502 `stalwart_unavailable`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement per contract.**
- [ ] **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** — `feat(server): add sse bridge for jmap push notifications`

---

### Task 8: Wire-up, env plumbing, docs, verification

**Files:**
- Modify: `apps/server/src/index.ts`, `.env.example`, `docker-compose.dev.yml`, `docs/DEVELOPMENT.md`, `.gitignore`

**Steps:**

- [ ] **Step 1: index.ts** — after the existing wiring add:

```ts
import { createJmapClient } from "./infra/stalwart/jmap";
import { createMailRouter } from "./modules/mail/router";
```

```ts
const jmap = config.stalwartUrl ? createJmapClient({ baseUrl: config.stalwartUrl }) : null;
```

and pass to `createApp`:

```ts
  mailRouter: createMailRouter({ sessions, mailCredentials, jmap }),
```

Log one info line at startup: `log("info", "mail proxy", { configured: jmap !== null })`.

- [ ] **Step 2: .env.example** — append:

```ini
# Base URL of the Stalwart JMAP server (internal network). When empty, the
# mail endpoints answer 503 mail_not_configured.
STALWART_URL=
```

- [ ] **Step 3: docker-compose.dev.yml** — add to the dev service environment: `STALWART_URL: ""` (explicitly unconfigured in local dev; document that developers with a reachable Stalwart can point it there).

- [ ] **Step 4: docs/DEVELOPMENT.md** — append (Spanish, matching the file):

```markdown
## Correo (Stalwart)

La API de correo usa la variable `STALWART_URL` (URL interna del servidor
JMAP). Sin ella, los endpoints de correo responden 503
`mail_not_configured` — útil en desarrollo sin un Stalwart accesible. Los
tests no necesitan Stalwart: usan un cliente JMAP simulado.
```

- [ ] **Step 5: .gitignore** — add a line `.vite/` under the build artifacts section (dev-container Vite cache).

- [ ] **Step 6: Verification**

```bash
bun run typecheck    # 3 packages clean
bun run test         # all suites green (Postgres 5434 up)
```

Then confirm 503 behavior live: recreate the dev container (`docker compose -f docker-compose.dev.yml up -d --force-recreate dev`), poll `http://localhost:8090/api/health` until 200, then `curl -s http://localhost:8090/api/mail/mailboxes` → expect the 401 envelope (no session) — and the startup log line shows `"configured":false`.

- [ ] **Step 7: Commit** — `feat(server): wire mail router and stalwart config into the app entry`

---

## Out of Scope

- Plan 3b: web mail UI (three-pane layout, virtualized list, thread view with sanitized iframe, search box, SSE invalidation hook).
- Plan 4: composer, identities, signatures, send, attachment upload/download/preview (blob streaming endpoints).
- JMAP session cache invalidation on credential change (acceptable: 5-minute TTL bounds staleness).
