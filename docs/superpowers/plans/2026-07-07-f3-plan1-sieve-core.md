# F3 Plan 1/3 — Sieve Core (server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side foundation for mail filter rules and vacation auto-replies: Postgres tables, shared Zod contracts, a pure Sieve script generator with injection-proof escaping, JMAP-for-Sieve (RFC 9661) support in the Stalwart client, a sync service that regenerates and activates the managed script, and session-guarded CRUD endpoints.

**Architecture:** Postgres is the source of truth; the Sieve script is a derived artifact. Every mutation regenerates the FULL script from all rules + vacation settings via a pure generator, uploads it as a blob, validates it with `SieveScript/validate`, and activates it with `SieveScript/set` — all over the existing JMAP client with the `urn:ietf:params:jmap:sieve` capability added. No ManageSieve, no new network surface. See `docs/superpowers/specs/2026-07-07-phase3-sieve-filters-design.md`.

**Tech Stack:** existing — Bun + Hono + TS, Zod, postgres.js, Vitest. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; conventional commits; no AI attribution; no compiled `.js` committed.
- TDD per task: write the test, run it and SEE IT FAIL (capture output), implement, see it pass; both outputs in the report.
- Error envelope `{ code, message, traceId }` with `message` an i18n key (`errors.<code>`).
- **NEVER generate a Sieve `redirect` action.** Auto-forwarding is excluded by company policy. There is no code path that emits `redirect`; do not add one.
- **Every user-supplied string that reaches the Sieve script MUST pass through the generator's escaping (`quote()` / `textBlock()`).** Sieve injection is the F3 security risk; tests attack it explicitly.
- Mailbox credentials are never logged; mail content is never logged or audited.
- `apps/server/vitest.config.ts` has `fileParallelism: false` — keep it.
- Postgres for integration tests: dev container on host port 5434, `DATABASE_URL` fallback `postgres://webmail:webmail@localhost:5434/webmail`.
- NEVER kill processes globally; prefer running inside the dev container.
- Every task runs `bun run typecheck` (in the packages it touches) and its tests before committing.
- Branch: `init-sieve-filters`.

## Out of Scope (later plans)

- All UI (rule builder, vacation panel, retry button) — Plan 2.
- Manual forward in the composer — Plan 3.
- Raw Sieve editor — issue #23.

---

### Task 1: Shared contracts + migration

**Files:**
- Create: `packages/shared/src/api/sieve.ts`
- Create: `apps/server/migrations/0003_sieve_filters.sql`
- Modify: `packages/shared/src/index.ts` (add barrel export)

**Interfaces (produces):** every schema/type below, consumed by all later tasks. Copy them verbatim.

- [ ] **Step 1: Write the migration** — `apps/server/migrations/0003_sieve_filters.sql`:

```sql
create table filter_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  position integer not null,
  name text not null,
  match_type text not null default 'all' check (match_type in ('all', 'any')),
  conditions jsonb not null default '[]',
  actions jsonb not null default '[]',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index filter_rules_user_position_idx on filter_rules (user_id, position);

create table vacation_settings (
  user_id uuid primary key references users(id) on delete cascade,
  enabled boolean not null default false,
  subject text not null default '',
  message text not null default '',
  starts_at date,
  ends_at date,
  interval_days integer not null default 7 check (interval_days between 1 and 60),
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 2: Write the shared contracts** — `packages/shared/src/api/sieve.ts`:

```ts
import { z } from "zod";

const singleLine = (max: number) =>
  z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const filterConditionSchema = z.object({
  field: z.enum(["from", "to", "subject", "body"]),
  op: z.enum(["contains", "is"]),
  value: singleLine(500).min(1),
});
export type FilterCondition = z.infer<typeof filterConditionSchema>;

export const filterActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fileinto"), folder: singleLine(200).min(1) }),
  z.object({ type: z.literal("seen") }),
  z.object({
    type: z.literal("flag"),
    keyword: z.string().min(1).max(64).regex(/^[A-Za-z0-9$_.-]+$/),
  }),
  z.object({ type: z.literal("delete") }),
  z.object({ type: z.literal("stop") }),
]);
export type FilterAction = z.infer<typeof filterActionSchema>;

export const filterRuleSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  name: z.string(),
  matchType: z.enum(["all", "any"]),
  conditions: z.array(filterConditionSchema),
  actions: z.array(filterActionSchema),
  enabled: z.boolean(),
});
export type FilterRule = z.infer<typeof filterRuleSchema>;

export const filterRuleInputSchema = z.object({
  name: singleLine(100).min(1),
  matchType: z.enum(["all", "any"]),
  conditions: z.array(filterConditionSchema).min(1).max(10),
  actions: z.array(filterActionSchema).min(1).max(10),
  enabled: z.boolean().default(true),
});
export type FilterRuleInput = z.infer<typeof filterRuleInputSchema>;

export const filterOrderSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
});
export type FilterOrder = z.infer<typeof filterOrderSchema>;

export const vacationSettingsSchema = z.object({
  enabled: z.boolean(),
  subject: z.string(),
  message: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  intervalDays: z.number().int(),
});
export type VacationSettings = z.infer<typeof vacationSettingsSchema>;

export const vacationSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    subject: singleLine(200).default(""),
    message: z.string().max(5000).default(""),
    startsAt: isoDate.nullable().default(null),
    endsAt: isoDate.nullable().default(null),
    intervalDays: z.number().int().min(1).max(60).default(7),
  })
  .refine((value) => !value.enabled || value.message.trim().length > 0, {
    message: "message required when enabled",
    path: ["message"],
  })
  .refine(
    (value) =>
      value.startsAt === null || value.endsAt === null || value.startsAt <= value.endsAt,
    { message: "endsAt must not be before startsAt", path: ["endsAt"] },
  );
export type VacationSettingsInput = z.infer<typeof vacationSettingsInputSchema>;
```

- [ ] **Step 3: Add barrel export** — in `packages/shared/src/index.ts` append:

```ts
export * from "./api/sieve";
```

- [ ] **Step 4: Typecheck + apply migration**

Run: `cd packages/shared && bun run typecheck` — Expected: no errors.
Run: `cd apps/server && bun run typecheck` — Expected: no errors.
Run: `cd apps/server && DATABASE_URL=postgres://webmail:webmail@localhost:5434/webmail bun run migrate` — Expected: `migrations applied`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/sieve.ts packages/shared/src/index.ts apps/server/migrations/0003_sieve_filters.sql
git commit -m "feat(shared): sieve filter and vacation contracts + migration"
```

---

### Task 2: Sieve generator (pure function) — the security-critical task

**Files:**
- Create: `apps/server/src/modules/sieve/generator.ts`
- Test: `apps/server/src/modules/sieve/generator.test.ts`

**Interfaces:**
- Consumes: `FilterRule`, `VacationSettings`, `FilterAction`, `FilterCondition` from `@webmail/shared` (Task 1).
- Produces: `generateSieveScript(input: SieveGeneratorInput): string` with `SieveGeneratorInput = { rules: FilterRule[]; vacation: VacationSettings | null; trashFolder: string }`. Task 5 calls it.

Semantics the tests must pin down:
- Rules sorted by `position`; disabled rules and rules with empty conditions/actions are skipped.
- `matchType` `all` → `allof`, `any` → `anyof`; single condition emitted without a combinator.
- `delete` action → `fileinto <trashFolder>` (trash resolved by the caller). NO `discard`, NO `redirect` ever.
- Vacation emitted last, only when `enabled` and message non-blank; date range via `currentdate`; `require` line lists only the extensions actually used, sorted.
- Empty output (no active rules, no vacation) → `""` (empty string).
- ALL user values pass through `quote()` (single-line, control chars → space, `\` and `"` escaped) or `textBlock()` (multiline `text:` block with CRLF normalization and dot-stuffing).

- [ ] **Step 1: Write the failing tests** — `apps/server/src/modules/sieve/generator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FilterRule, VacationSettings } from "@webmail/shared";
import { generateSieveScript } from "./generator";

function rule(overrides: Partial<FilterRule>): FilterRule {
  return {
    id: "r1",
    position: 0,
    name: "test rule",
    matchType: "all",
    conditions: [{ field: "from", op: "contains", value: "a@b.com" }],
    actions: [{ type: "fileinto", folder: "Archive" }],
    enabled: true,
    ...overrides,
  };
}

function vacation(overrides: Partial<VacationSettings>): VacationSettings {
  return {
    enabled: true,
    subject: "",
    message: "I am away",
    startsAt: null,
    endsAt: null,
    intervalDays: 7,
    ...overrides,
  };
}

const base = { vacation: null, trashFolder: "Trash" };

describe("generateSieveScript", () => {
  it("returns empty string with no rules and no vacation", () => {
    expect(generateSieveScript({ rules: [], ...base })).toBe("");
  });

  it("generates a complete simple script exactly", () => {
    const script = generateSieveScript({
      rules: [
        rule({
          name: "invoices",
          conditions: [{ field: "from", op: "contains", value: "billing@acme.com" }],
          actions: [{ type: "fileinto", folder: "Invoices" }],
        }),
      ],
      ...base,
    });
    expect(script).toBe(
      "# Generated by webmail. Do not edit manually.\n\n" +
        'require ["fileinto"];\n\n' +
        "# rule: invoices\n" +
        'if header :contains "from" "billing@acme.com" {\n' +
        '  fileinto "Invoices";\n' +
        "}\n",
    );
  });

  it("maps every condition field and op", () => {
    const script = generateSieveScript({
      rules: [
        rule({
          matchType: "any",
          conditions: [
            { field: "from", op: "is", value: "boss@acme.com" },
            { field: "to", op: "contains", value: "team@" },
            { field: "subject", op: "contains", value: "urgent" },
            { field: "body", op: "contains", value: "invoice" },
          ],
        }),
      ],
      ...base,
    });
    expect(script).toContain(
      'anyof (header :is "from" "boss@acme.com", ' +
        'header :contains ["to", "cc"] "team@", ' +
        'header :contains "subject" "urgent", ' +
        'body :text :contains "invoice")',
    );
    expect(script).toContain('require ["body", "fileinto"];');
  });

  it("maps every action type", () => {
    const script = generateSieveScript({
      rules: [
        rule({
          actions: [
            { type: "seen" },
            { type: "flag", keyword: "Important" },
            { type: "delete" },
            { type: "stop" },
          ],
        }),
      ],
      trashFolder: "Papelera",
      vacation: null,
    });
    expect(script).toContain('addflag "\\\\Seen";');
    expect(script).toContain('addflag "Important";');
    expect(script).toContain('fileinto "Papelera";');
    expect(script).toContain("stop;");
    expect(script).toContain('require ["fileinto", "imap4flags"];');
    expect(script).not.toContain("redirect");
    expect(script).not.toContain("discard");
  });

  it("orders rules by position and skips disabled ones", () => {
    const script = generateSieveScript({
      rules: [
        rule({ id: "b", position: 2, name: "second" }),
        rule({ id: "c", position: 1, name: "disabled", enabled: false }),
        rule({ id: "a", position: 0, name: "first" }),
      ],
      ...base,
    });
    expect(script.indexOf("# rule: first")).toBeGreaterThan(-1);
    expect(script.indexOf("# rule: first")).toBeLessThan(script.indexOf("# rule: second"));
    expect(script).not.toContain("disabled");
  });

  it("escapes quotes and backslashes in user values (injection attack)", () => {
    const script = generateSieveScript({
      rules: [
        rule({
          conditions: [
            {
              field: "from",
              op: "contains",
              value: 'x"; discard; if true { redirect "a@evil.com" }',
            },
          ],
        }),
      ],
      ...base,
    });
    expect(script).toContain(
      'header :contains "from" "x\\"; discard; if true { redirect \\"a@evil.com\\" }"',
    );
    // the injected text stays inside ONE quoted string: no statement boundary escaped
    expect(script).not.toMatch(/^\s*discard/m);
    expect(script).not.toMatch(/^\s*redirect/m);
  });

  it("escapes backslashes before quotes", () => {
    const script = generateSieveScript({
      rules: [rule({ conditions: [{ field: "subject", op: "is", value: 'a\\"b' }] })],
      ...base,
    });
    expect(script).toContain(String.raw`"a\\\"b"`);
  });

  it("replaces control characters in single-line values", () => {
    const script = generateSieveScript({
      rules: [
        rule({
          name: "evil\nname",
          conditions: [{ field: "subject", op: "contains", value: "a\nstop;" }],
        }),
      ],
      ...base,
    });
    expect(script).toContain("# rule: evil name");
    expect(script).toContain('"a stop;"');
  });

  it("generates vacation with defaults", () => {
    const script = generateSieveScript({
      rules: [],
      vacation: vacation({}),
      trashFolder: "Trash",
    });
    expect(script).toContain('require ["vacation"];');
    expect(script).toContain("vacation :days 7 text:\r\nI am away\r\n.\r\n;");
  });

  it("generates vacation with subject and date range", () => {
    const script = generateSieveScript({
      rules: [],
      vacation: vacation({
        subject: "Out of office",
        startsAt: "2026-07-10",
        endsAt: "2026-07-20",
        intervalDays: 3,
      }),
      trashFolder: "Trash",
    });
    expect(script).toContain('require ["date", "relational", "vacation"];');
    expect(script).toContain(
      'if allof (currentdate :value "ge" "date" "2026-07-10", currentdate :value "le" "date" "2026-07-20") {',
    );
    expect(script).toContain(':days 3 :subject "Out of office" text:');
  });

  it("dot-stuffs vacation message lines (text: block injection attack)", () => {
    const script = generateSieveScript({
      rules: [],
      vacation: vacation({ message: "Away.\n.\n..danger" }),
      trashFolder: "Trash",
    });
    expect(script).toContain("text:\r\nAway.\r\n..\r\n...danger\r\n.\r\n;");
  });

  it("skips vacation when disabled or message blank", () => {
    expect(
      generateSieveScript({ rules: [], vacation: vacation({ enabled: false }), trashFolder: "Trash" }),
    ).toBe("");
    expect(
      generateSieveScript({ rules: [], vacation: vacation({ message: "  " }), trashFolder: "Trash" }),
    ).toBe("");
  });

  it("puts vacation after all filter rules", () => {
    const script = generateSieveScript({
      rules: [rule({})],
      vacation: vacation({}),
      trashFolder: "Trash",
    });
    expect(script.indexOf("if header")).toBeLessThan(script.indexOf("vacation :days"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run test -- src/modules/sieve/generator.test.ts`
Expected: FAIL — cannot resolve `./generator`.

- [ ] **Step 3: Implement** — `apps/server/src/modules/sieve/generator.ts`:

```ts
import type {
  FilterAction,
  FilterCondition,
  FilterRule,
  VacationSettings,
} from "@webmail/shared";

export type SieveGeneratorInput = {
  rules: FilterRule[];
  vacation: VacationSettings | null;
  trashFolder: string;
};

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function quote(value: string): string {
  return `"${sanitizeSingleLine(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function textBlock(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `text:\r\n${lines.join("\r\n")}\r\n.\r\n`;
}

function conditionToSieve(condition: FilterCondition, requires: Set<string>): string {
  const match = condition.op === "is" ? ":is" : ":contains";
  const value = quote(condition.value);
  switch (condition.field) {
    case "from":
      return `header ${match} "from" ${value}`;
    case "to":
      return `header ${match} ["to", "cc"] ${value}`;
    case "subject":
      return `header ${match} "subject" ${value}`;
    case "body":
      requires.add("body");
      return `body :text ${match} ${value}`;
  }
}

function actionToSieve(
  action: FilterAction,
  trashFolder: string,
  requires: Set<string>,
): string {
  switch (action.type) {
    case "fileinto":
      requires.add("fileinto");
      return `fileinto ${quote(action.folder)};`;
    case "seen":
      requires.add("imap4flags");
      return `addflag "\\\\Seen";`;
    case "flag":
      requires.add("imap4flags");
      return `addflag ${quote(action.keyword)};`;
    case "delete":
      requires.add("fileinto");
      return `fileinto ${quote(trashFolder)};`;
    case "stop":
      return "stop;";
  }
}

function ruleToSieve(rule: FilterRule, trashFolder: string, requires: Set<string>): string {
  const tests = rule.conditions.map((condition) => conditionToSieve(condition, requires));
  const combinator = rule.matchType === "any" ? "anyof" : "allof";
  const test = tests.length === 1 ? tests[0]! : `${combinator} (${tests.join(", ")})`;
  const actions = rule.actions
    .map((action) => `  ${actionToSieve(action, trashFolder, requires)}`)
    .join("\n");
  return `# rule: ${sanitizeSingleLine(rule.name)}\nif ${test} {\n${actions}\n}`;
}

function vacationToSieve(vacation: VacationSettings, requires: Set<string>): string {
  requires.add("vacation");
  const args = [`:days ${vacation.intervalDays}`];
  if (vacation.subject !== "") {
    args.push(`:subject ${quote(vacation.subject)}`);
  }
  const command = `vacation ${args.join(" ")} ${textBlock(vacation.message)};`;
  const dateTests: string[] = [];
  if (vacation.startsAt) {
    dateTests.push(`currentdate :value "ge" "date" ${quote(vacation.startsAt)}`);
  }
  if (vacation.endsAt) {
    dateTests.push(`currentdate :value "le" "date" ${quote(vacation.endsAt)}`);
  }
  if (dateTests.length === 0) {
    return command;
  }
  requires.add("date");
  requires.add("relational");
  const test = dateTests.length === 1 ? dateTests[0]! : `allof (${dateTests.join(", ")})`;
  return `if ${test} {\n  ${command}\n}`;
}

export function generateSieveScript(input: SieveGeneratorInput): string {
  const requires = new Set<string>();
  const parts: string[] = [];
  const rules = [...input.rules].sort((a, b) => a.position - b.position);
  for (const rule of rules) {
    if (!rule.enabled || rule.conditions.length === 0 || rule.actions.length === 0) {
      continue;
    }
    parts.push(ruleToSieve(rule, input.trashFolder, requires));
  }
  const vacation = input.vacation;
  if (vacation && vacation.enabled && vacation.message.trim() !== "") {
    parts.push(vacationToSieve(vacation, requires));
  }
  if (parts.length === 0) {
    return "";
  }
  const header = "# Generated by webmail. Do not edit manually.";
  const requireLine = `require [${[...requires]
    .sort()
    .map((name) => `"${name}"`)
    .join(", ")}];`;
  const sections = requires.size > 0 ? [header, requireLine, ...parts] : [header, ...parts];
  return `${sections.join("\n\n")}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun run test -- src/modules/sieve/generator.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/server && bun run typecheck` — Expected: no errors.

```bash
git add apps/server/src/modules/sieve/generator.ts apps/server/src/modules/sieve/generator.test.ts
git commit -m "feat(sieve): pure sieve script generator with injection-safe escaping"
```

---

### Task 3: JMAP client — sieve capability + blob upload

**Files:**
- Modify: `apps/server/src/infra/stalwart/jmap.ts`
- Test: `apps/server/src/infra/stalwart/jmap-sieve.test.ts` (new file)

**Interfaces:**
- Consumes: existing `createJmapClient`, `JmapAuth`, `JmapSession`, `JmapMethodCall`.
- Produces (Task 5 relies on these exact signatures):
  - `request(auth, session, calls, extraUsing?: string[])` — 4th OPTIONAL param, default `[]`, appended to the `using` array.
  - `uploadBlob(auth: JmapAuth, session: JmapSession, content: string, contentType: string): Promise<string>` — returns `blobId`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/infra/stalwart/jmap-sieve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createJmapClient, type JmapSession } from "./jmap";

const auth = { email: "u@noxvytop.com", password: "pw" };
const session: JmapSession = {
  apiUrl: "http://stalwart/jmap/api",
  accountId: "acc1",
  eventSourceUrl: "",
  uploadUrl: "http://stalwart/jmap/upload/{accountId}/",
  downloadUrl: "",
};

describe("jmap client sieve support", () => {
  it("appends extraUsing capabilities to the using array", async () => {
    let sentBody: { using: string[] } | null = null;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ methodResponses: [["SieveScript/get", {}, "0"]] }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    await client.request(
      auth,
      session,
      [["SieveScript/get", { accountId: "acc1" }, "0"]],
      ["urn:ietf:params:jmap:sieve"],
    );
    expect(sentBody!.using).toContain("urn:ietf:params:jmap:core");
    expect(sentBody!.using).toContain("urn:ietf:params:jmap:sieve");
  });

  it("does not change the using array when extraUsing is omitted", async () => {
    let sentBody: { using: string[] } | null = null;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ methodResponses: [["Mailbox/get", {}, "0"]] }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    await client.request(auth, session, [["Mailbox/get", { accountId: "acc1" }, "0"]]);
    expect(sentBody!.using).toEqual([
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ]);
  });

  it("uploads a blob to the accountId-expanded upload url and returns blobId", async () => {
    let sentUrl = "";
    let sentContentType = "";
    let sentBody = "";
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      sentUrl = String(url);
      sentContentType = (init!.headers as Record<string, string>)["content-type"];
      sentBody = init!.body as string;
      return new Response(JSON.stringify({ blobId: "blob42" }), { status: 200 });
    }) as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    const blobId = await client.uploadBlob(auth, session, "require [];", "application/sieve");
    expect(blobId).toBe("blob42");
    expect(sentUrl).toBe("http://stalwart/jmap/upload/acc1/");
    expect(sentContentType).toBe("application/sieve");
    expect(sentBody).toBe("require [];");
  });

  it("throws a domain error when upload fails", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    await expect(
      client.uploadBlob(auth, session, "x", "application/sieve"),
    ).rejects.toMatchObject({ code: "stalwart_unavailable" });
  });
});
```

Note: if `DomainError` does not expose a `code` property, check the actual field name in `apps/server/src/core/errors.ts` and adjust the last assertion to match (e.g. `.rejects.toBeInstanceOf(DomainError)` plus the real field).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run test -- src/infra/stalwart/jmap-sieve.test.ts`
Expected: FAIL — `request` rejects the 4th argument type / `uploadBlob` is not a function.

- [ ] **Step 3: Implement** — in `apps/server/src/infra/stalwart/jmap.ts`:

Change the `request` signature and `using` array:

```ts
    async request(
      auth: JmapAuth,
      session: JmapSession,
      calls: JmapMethodCall[],
      extraUsing: string[] = [],
    ): Promise<JmapMethodResponse[]> {
      const res = await fetchFn(session.apiUrl, {
        method: "POST",
        headers: {
          authorization: basicAuth(auth),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          using: [
            "urn:ietf:params:jmap:core",
            "urn:ietf:params:jmap:mail",
            "urn:ietf:params:jmap:submission",
            ...extraUsing,
          ],
          methodCalls: calls,
        }),
      });
```

(rest of `request` unchanged). Add `uploadBlob` as a sibling method inside the returned object:

```ts
    async uploadBlob(
      auth: JmapAuth,
      session: JmapSession,
      content: string,
      contentType: string,
    ): Promise<string> {
      const url = session.uploadUrl.replace(
        "{accountId}",
        encodeURIComponent(session.accountId),
      );
      const res = await fetchFn(url, {
        method: "POST",
        headers: { authorization: basicAuth(auth), "content-type": contentType },
        body: content,
      });
      if (!res.ok) throw toDomainError(res.status);
      const body = (await res.json()) as { blobId?: string };
      if (!body.blobId) {
        throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
      }
      return body.blobId;
    },
```

- [ ] **Step 4: Run ALL server tests to verify nothing broke**

Run: `cd apps/server && bun run test`
Expected: PASS (new sieve tests + all existing suites — the optional 4th param is backward compatible).

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/server && bun run typecheck` — Expected: no errors.

```bash
git add apps/server/src/infra/stalwart/jmap.ts apps/server/src/infra/stalwart/jmap-sieve.test.ts
git commit -m "feat(jmap): optional extra capabilities and blob upload for sieve"
```

---

### Task 4: Repos — filter rules + vacation settings

**Files:**
- Create: `apps/server/src/infra/repos/filter-rules.ts`
- Create: `apps/server/src/infra/repos/vacation-settings.ts`
- Test: `apps/server/src/infra/repos/sieve-repos.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `Db` from `../db/client`; tables from migration 0003.
- Produces (Task 6 relies on these):
  - `createFilterRulesRepo(sql: Db)` → `{ list(userId): Promise<FilterRule[]>; create(userId, input: FilterRuleInput): Promise<FilterRule>; update(userId, id, input): Promise<FilterRule | null>; remove(userId, id): Promise<boolean>; reorder(userId, ids: string[]): Promise<boolean> }` + `export type FilterRulesRepo`.
  - `createVacationSettingsRepo(sql: Db)` → `{ get(userId): Promise<VacationSettings>; set(userId, input: VacationSettingsInput): Promise<VacationSettings> }` + `export type VacationSettingsRepo`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/infra/repos/sieve-repos.test.ts` (same DB bootstrap as `repos.test.ts`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../db/client";
import { migrate } from "../db/migrate";
import { createUsersRepo } from "./users";
import { createFilterRulesRepo } from "./filter-rules";
import { createVacationSettingsRepo } from "./vacation-settings";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let userId: string;
let otherUserId: string;
const filterRules = createFilterRulesRepo(sql);
const vacationSettings = createVacationSettingsRepo(sql);

const input = {
  name: "invoices",
  matchType: "all" as const,
  conditions: [{ field: "from" as const, op: "contains" as const, value: "billing@" }],
  actions: [{ type: "fileinto" as const, folder: "Invoices" }],
  enabled: true,
};

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const user1 = await users.create({
    email: `sieve1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve User 1",
  });
  userId = user1.id;
  const user2 = await users.create({
    email: `sieve2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve User 2",
  });
  otherUserId = user2.id;
});
afterAll(() => sql.end());

describe("filter rules repo", () => {
  it("creates rules with incrementing positions and lists in order", async () => {
    const first = await filterRules.create(userId, input);
    const second = await filterRules.create(userId, { ...input, name: "newsletters" });
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    expect(first.conditions).toEqual(input.conditions);
    expect(first.actions).toEqual(input.actions);
    const list = await filterRules.list(userId);
    expect(list.map((r) => r.name)).toEqual(["invoices", "newsletters"]);
  });

  it("updates only own rules", async () => {
    const list = await filterRules.list(userId);
    const target = list[0]!;
    const updated = await filterRules.update(userId, target.id, { ...input, name: "renamed" });
    expect(updated?.name).toBe("renamed");
    const foreign = await filterRules.update(otherUserId, target.id, input);
    expect(foreign).toBeNull();
  });

  it("reorders with a complete id set and rejects partial or foreign sets", async () => {
    const list = await filterRules.list(userId);
    const reversed = [...list].reverse().map((r) => r.id);
    expect(await filterRules.reorder(userId, reversed)).toBe(true);
    const after = await filterRules.list(userId);
    expect(after.map((r) => r.id)).toEqual(reversed);
    expect(await filterRules.reorder(userId, [reversed[0]!])).toBe(false);
    expect(await filterRules.reorder(otherUserId, reversed)).toBe(false);
  });

  it("removes only own rules", async () => {
    const created = await filterRules.create(userId, { ...input, name: "temp" });
    expect(await filterRules.remove(otherUserId, created.id)).toBe(false);
    expect(await filterRules.remove(userId, created.id)).toBe(true);
  });
});

describe("vacation settings repo", () => {
  it("returns defaults when no row exists", async () => {
    const settings = await vacationSettings.get(userId);
    expect(settings).toEqual({
      enabled: false,
      subject: "",
      message: "",
      startsAt: null,
      endsAt: null,
      intervalDays: 7,
    });
  });

  it("upserts and returns date-only strings", async () => {
    const saved = await vacationSettings.set(userId, {
      enabled: true,
      subject: "Out",
      message: "Away until the 20th",
      startsAt: "2026-07-10",
      endsAt: "2026-07-20",
      intervalDays: 3,
    });
    expect(saved.startsAt).toBe("2026-07-10");
    expect(saved.endsAt).toBe("2026-07-20");
    const again = await vacationSettings.set(userId, {
      enabled: false,
      subject: "",
      message: "",
      startsAt: null,
      endsAt: null,
      intervalDays: 7,
    });
    expect(again.enabled).toBe(false);
    expect(again.startsAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run test -- src/infra/repos/sieve-repos.test.ts`
Expected: FAIL — cannot resolve `./filter-rules`.

- [ ] **Step 3: Implement** — `apps/server/src/infra/repos/filter-rules.ts`:

```ts
import type { FilterRule, FilterRuleInput } from "@webmail/shared";
import type { Db } from "../db/client";

type FilterRuleRow = {
  id: string;
  position: number;
  name: string;
  match_type: string;
  conditions: FilterRule["conditions"];
  actions: FilterRule["actions"];
  enabled: boolean;
};

function toFilterRule(row: FilterRuleRow): FilterRule {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    matchType: row.match_type as FilterRule["matchType"],
    conditions: row.conditions,
    actions: row.actions,
    enabled: row.enabled,
  };
}

export function createFilterRulesRepo(sql: Db) {
  return {
    async list(userId: string): Promise<FilterRule[]> {
      const rows = await sql<FilterRuleRow[]>`
        select id, position, name, match_type, conditions, actions, enabled
        from filter_rules
        where user_id = ${userId}
        order by position asc, created_at asc
      `;
      return rows.map(toFilterRule);
    },

    async create(userId: string, input: FilterRuleInput): Promise<FilterRule> {
      return sql.begin(async (tx) => {
        const positions = await tx<{ next: number }[]>`
          select coalesce(max(position), -1) + 1 as next
          from filter_rules where user_id = ${userId}
        `;
        const rows = await tx<FilterRuleRow[]>`
          insert into filter_rules (user_id, position, name, match_type, conditions, actions, enabled)
          values (
            ${userId}, ${positions[0]!.next}, ${input.name}, ${input.matchType},
            ${JSON.stringify(input.conditions)}::jsonb,
            ${JSON.stringify(input.actions)}::jsonb,
            ${input.enabled}
          )
          returning id, position, name, match_type, conditions, actions, enabled
        `;
        return toFilterRule(rows[0]!);
      });
    },

    async update(
      userId: string,
      id: string,
      input: FilterRuleInput,
    ): Promise<FilterRule | null> {
      const rows = await sql<FilterRuleRow[]>`
        update filter_rules
        set name = ${input.name},
            match_type = ${input.matchType},
            conditions = ${JSON.stringify(input.conditions)}::jsonb,
            actions = ${JSON.stringify(input.actions)}::jsonb,
            enabled = ${input.enabled}
        where id = ${id} and user_id = ${userId}
        returning id, position, name, match_type, conditions, actions, enabled
      `;
      return rows[0] ? toFilterRule(rows[0]) : null;
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const rows = await sql`
        delete from filter_rules where id = ${id} and user_id = ${userId} returning id
      `;
      return rows.length > 0;
    },

    async reorder(userId: string, ids: string[]): Promise<boolean> {
      return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id from filter_rules where user_id = ${userId}
        `;
        const owned = new Set(rows.map((row) => row.id));
        if (ids.length !== owned.size || !ids.every((id) => owned.has(id))) {
          return false;
        }
        for (const [index, id] of ids.entries()) {
          await tx`
            update filter_rules set position = ${index}
            where id = ${id} and user_id = ${userId}
          `;
        }
        return true;
      });
    },
  };
}

export type FilterRulesRepo = ReturnType<typeof createFilterRulesRepo>;
```

And `apps/server/src/infra/repos/vacation-settings.ts`:

```ts
import type { VacationSettings, VacationSettingsInput } from "@webmail/shared";
import type { Db } from "../db/client";

type VacationRow = {
  enabled: boolean;
  subject: string;
  message: string;
  starts_at: string | null;
  ends_at: string | null;
  interval_days: number;
};

const DEFAULTS: VacationSettings = {
  enabled: false,
  subject: "",
  message: "",
  startsAt: null,
  endsAt: null,
  intervalDays: 7,
};

function toVacationSettings(row: VacationRow): VacationSettings {
  return {
    enabled: row.enabled,
    subject: row.subject,
    message: row.message,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    intervalDays: row.interval_days,
  };
}

export function createVacationSettingsRepo(sql: Db) {
  return {
    async get(userId: string): Promise<VacationSettings> {
      const rows = await sql<VacationRow[]>`
        select enabled, subject, message,
               starts_at::text as starts_at, ends_at::text as ends_at, interval_days
        from vacation_settings
        where user_id = ${userId}
      `;
      return rows[0] ? toVacationSettings(rows[0]) : { ...DEFAULTS };
    },

    async set(userId: string, input: VacationSettingsInput): Promise<VacationSettings> {
      const rows = await sql<VacationRow[]>`
        insert into vacation_settings
          (user_id, enabled, subject, message, starts_at, ends_at, interval_days)
        values
          (${userId}, ${input.enabled}, ${input.subject}, ${input.message},
           ${input.startsAt}, ${input.endsAt}, ${input.intervalDays})
        on conflict (user_id) do update set
          enabled = excluded.enabled,
          subject = excluded.subject,
          message = excluded.message,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          interval_days = excluded.interval_days,
          updated_at = now()
        returning enabled, subject, message,
                  starts_at::text as starts_at, ends_at::text as ends_at, interval_days
      `;
      return toVacationSettings(rows[0]!);
    },
  };
}

export type VacationSettingsRepo = ReturnType<typeof createVacationSettingsRepo>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun run test -- src/infra/repos/sieve-repos.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/server && bun run typecheck` — Expected: no errors.

```bash
git add apps/server/src/infra/repos/filter-rules.ts apps/server/src/infra/repos/vacation-settings.ts apps/server/src/infra/repos/sieve-repos.test.ts
git commit -m "feat(sieve): filter rules and vacation settings repos"
```

---

### Task 5: Sieve sync service

**Files:**
- Create: `apps/server/src/modules/sieve/sync.ts`
- Test: `apps/server/src/modules/sieve/sync.test.ts`

**Interfaces:**
- Consumes: `generateSieveScript` (Task 2); `JmapClient` with `request(..., extraUsing)` + `uploadBlob` (Task 3); `DomainError` from `../../core/errors`.
- Produces (Task 6 relies on this): `syncSieveScript(input: { jmap: JmapClient; auth: JmapAuth; session: JmapSession; rules: FilterRule[]; vacation: VacationSettings | null }): Promise<void>` plus exported constants `SIEVE_CAPABILITY = "urn:ietf:params:jmap:sieve"` and `MANAGED_SCRIPT_NAME = "webmail"`. Throws `DomainError("sieve_invalid", ...)` when Stalwart's validate rejects the script, `DomainError("sieve_sync_failed", ...)` when set/destroy is refused; network failures propagate as the client's own `DomainError`s.

Flow (RFC 9661): `Mailbox/get` (resolve the trash folder name by `role === "trash"`, fallback `"Trash"`) → generate script → if script is empty: destroy the managed script if it exists (with `onSuccessActivateScript: null`) and return → otherwise `uploadBlob(script, "application/sieve")` → `SieveScript/validate { blobId }` (reject if the response `error` is non-null) → `SieveScript/get` found an existing script named `webmail`? `SieveScript/set { update: { [id]: { blobId } }, onSuccessActivateScript: id }` : `SieveScript/set { create: { webmailScript: { name, blobId } }, onSuccessActivateScript: "#webmailScript" }`. Check `notCreated`/`notUpdated`/`notDestroyed` on every set response. All `SieveScript/*` calls pass `[SIEVE_CAPABILITY]` as `extraUsing`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/modules/sieve/sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FilterRule } from "@webmail/shared";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/stalwart/jmap";
import { MANAGED_SCRIPT_NAME, SIEVE_CAPABILITY, syncSieveScript } from "./sync";

const auth = { email: "u@noxvytop.com", password: "pw" };
const session: JmapSession = {
  apiUrl: "http://stalwart/jmap/api",
  accountId: "acc1",
  eventSourceUrl: "",
  uploadUrl: "http://stalwart/upload/{accountId}/",
  downloadUrl: "",
};

const sampleRule: FilterRule = {
  id: "r1",
  position: 0,
  name: "trash spam",
  matchType: "all",
  conditions: [{ field: "subject", op: "contains", value: "lottery" }],
  actions: [{ type: "delete" }],
  enabled: true,
};

type Recorded = { method: string; args: Record<string, unknown>; extraUsing: string[] };

function fakeJmap(options: {
  existingScripts?: { id: string; name: string }[];
  validateError?: unknown;
  setResponse?: Record<string, unknown>;
}) {
  const calls: Recorded[] = [];
  const uploads: string[] = [];
  const client = {
    async getSession() {
      return session;
    },
    async request(
      _auth: unknown,
      _session: unknown,
      methodCalls: JmapMethodCall[],
      extraUsing: string[] = [],
    ) {
      const [method, args] = methodCalls[0]!;
      calls.push({ method, args, extraUsing });
      if (method === "Mailbox/get") {
        return [["Mailbox/get", { list: [{ name: "Papelera", role: "trash" }] }, "0"]];
      }
      if (method === "SieveScript/get") {
        return [["SieveScript/get", { list: options.existingScripts ?? [] }, "0"]];
      }
      if (method === "SieveScript/validate") {
        return [["SieveScript/validate", { error: options.validateError ?? null }, "0"]];
      }
      if (method === "SieveScript/set") {
        return [["SieveScript/set", options.setResponse ?? {}, "0"]];
      }
      return [[method, {}, "0"]];
    },
    async uploadBlob(_auth: unknown, _session: unknown, content: string) {
      uploads.push(content);
      return "blob1";
    },
  } as unknown as JmapClient;
  return { client, calls, uploads };
}

describe("syncSieveScript", () => {
  it("uploads, validates, then creates and activates a new script", async () => {
    const { client, calls, uploads } = fakeJmap({});
    await syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('fileinto "Papelera";');
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["Mailbox/get", "SieveScript/get", "SieveScript/validate", "SieveScript/set"]);
    const set = calls.at(-1)!;
    expect(set.extraUsing).toEqual([SIEVE_CAPABILITY]);
    expect(set.args).toMatchObject({
      create: { webmailScript: { name: MANAGED_SCRIPT_NAME, blobId: "blob1" } },
      onSuccessActivateScript: "#webmailScript",
    });
  });

  it("updates the existing managed script", async () => {
    const { client, calls } = fakeJmap({
      existingScripts: [{ id: "s9", name: MANAGED_SCRIPT_NAME }],
    });
    await syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null });
    const set = calls.at(-1)!;
    expect(set.method).toBe("SieveScript/set");
    expect(set.args).toMatchObject({
      update: { s9: { blobId: "blob1" } },
      onSuccessActivateScript: "s9",
    });
  });

  it("destroys the managed script when nothing remains", async () => {
    const { client, calls, uploads } = fakeJmap({
      existingScripts: [{ id: "s9", name: MANAGED_SCRIPT_NAME }],
    });
    await syncSieveScript({ jmap: client, auth, session, rules: [], vacation: null });
    expect(uploads).toHaveLength(0);
    const set = calls.at(-1)!;
    expect(set.method).toBe("SieveScript/set");
    expect(set.args).toMatchObject({ destroy: ["s9"], onSuccessActivateScript: null });
  });

  it("does nothing when nothing remains and no managed script exists", async () => {
    const { client, calls } = fakeJmap({});
    await syncSieveScript({ jmap: client, auth, session, rules: [], vacation: null });
    expect(calls.map((c) => c.method)).toEqual(["Mailbox/get", "SieveScript/get"]);
  });

  it("throws sieve_invalid when validate rejects", async () => {
    const { client } = fakeJmap({ validateError: { type: "invalidScript" } });
    await expect(
      syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null }),
    ).rejects.toMatchObject({ code: "sieve_invalid" });
  });

  it("throws sieve_sync_failed when set is refused", async () => {
    const { client } = fakeJmap({
      setResponse: { notCreated: { webmailScript: { type: "forbidden" } } },
    });
    await expect(
      syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null }),
    ).rejects.toMatchObject({ code: "sieve_sync_failed" });
  });
});
```

(As in Task 3: if `DomainError` stores its code under a different property, adjust `toMatchObject` to the real field.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run test -- src/modules/sieve/sync.test.ts`
Expected: FAIL — cannot resolve `./sync`.

- [ ] **Step 3: Implement** — `apps/server/src/modules/sieve/sync.ts`:

```ts
import type { FilterRule, VacationSettings } from "@webmail/shared";
import { DomainError } from "../../core/errors";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/stalwart/jmap";
import { generateSieveScript } from "./generator";

export const SIEVE_CAPABILITY = "urn:ietf:params:jmap:sieve";
export const MANAGED_SCRIPT_NAME = "webmail";
const DEFAULT_TRASH_FOLDER = "Trash";

function assertSetSucceeded(result: Record<string, unknown>): void {
  for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
    const failures = result[key];
    if (failures && Object.keys(failures as Record<string, unknown>).length > 0) {
      throw new DomainError("sieve_sync_failed", 502, "errors.sieve_sync_failed");
    }
  }
}

export async function syncSieveScript(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  rules: FilterRule[];
  vacation: VacationSettings | null;
}): Promise<void> {
  const { jmap, auth, session } = input;
  const accountId = session.accountId;

  const mailboxResponses = await jmap.request(auth, session, [
    ["Mailbox/get", { accountId, properties: ["name", "role"] }, "0"],
  ]);
  const mailboxes =
    (mailboxResponses[0]?.[1] as { list?: { name: string; role?: string | null }[] })
      .list ?? [];
  const trashFolder =
    mailboxes.find((mailbox) => mailbox.role === "trash")?.name ?? DEFAULT_TRASH_FOLDER;

  const script = generateSieveScript({
    rules: input.rules,
    vacation: input.vacation,
    trashFolder,
  });

  const getResponses = await jmap.request(
    auth,
    session,
    [["SieveScript/get", { accountId, properties: ["name"] }, "0"]],
    [SIEVE_CAPABILITY],
  );
  const scripts =
    (getResponses[0]?.[1] as { list?: { id: string; name: string }[] }).list ?? [];
  const existing = scripts.find((s) => s.name === MANAGED_SCRIPT_NAME) ?? null;

  if (script === "") {
    if (existing) {
      const destroyResponses = await jmap.request(
        auth,
        session,
        [
          [
            "SieveScript/set",
            { accountId, destroy: [existing.id], onSuccessActivateScript: null },
            "0",
          ],
        ],
        [SIEVE_CAPABILITY],
      );
      assertSetSucceeded(destroyResponses[0]?.[1] ?? {});
    }
    return;
  }

  const blobId = await jmap.uploadBlob(auth, session, script, "application/sieve");

  const validateResponses = await jmap.request(
    auth,
    session,
    [["SieveScript/validate", { accountId, blobId }, "0"]],
    [SIEVE_CAPABILITY],
  );
  const validateResult = validateResponses[0]?.[1] as { error?: unknown };
  if (validateResult.error != null) {
    throw new DomainError("sieve_invalid", 502, "errors.sieve_invalid");
  }

  const setArgs = existing
    ? { accountId, update: { [existing.id]: { blobId } }, onSuccessActivateScript: existing.id }
    : {
        accountId,
        create: { webmailScript: { name: MANAGED_SCRIPT_NAME, blobId } },
        onSuccessActivateScript: "#webmailScript",
      };
  const setResponses = await jmap.request(
    auth,
    session,
    [["SieveScript/set", setArgs, "0"]],
    [SIEVE_CAPABILITY],
  );
  assertSetSucceeded(setResponses[0]?.[1] ?? {});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun run test -- src/modules/sieve/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/server && bun run typecheck` — Expected: no errors.

```bash
git add apps/server/src/modules/sieve/sync.ts apps/server/src/modules/sieve/sync.test.ts
git commit -m "feat(sieve): sync service uploading validated script via jmap"
```

---

### Task 6: Sieve router + wiring + integration tests

**Files:**
- Create: `apps/server/src/modules/sieve/router.ts`
- Modify: `apps/server/src/app.ts` (mount optional `sieveRouter` at `/api/mail`, following the exact pattern used for `mailRouter` — Hono supports multiple routers on the same prefix)
- Modify: `apps/server/src/index.ts` (construct `createFilterRulesRepo`, `createVacationSettingsRepo`, `createSieveRouter` and pass to `createApp`, following the mailRouter wiring pattern)
- Test: `apps/server/src/modules/sieve/router.test.ts`

**Interfaces:**
- Consumes: repos (Task 4), `syncSieveScript` (Task 5), `requireSession` from `../auth/middleware`, `MailDeps`/`MailVariables` types from `../mail/context`, schemas from Task 1.
- Produces: `createSieveRouter(deps: SieveDeps)`; endpoints under `/api/mail`:

| Route | Behavior |
|---|---|
| `GET /filters` | list rules |
| `POST /filters` | validate (`filterRuleInputSchema`) → create → sync |
| `PUT /filters/:id` | validate → update (404 if not owned) → sync |
| `DELETE /filters/:id` | remove (404 if not owned) → sync |
| `PUT /filters/order` | validate (`filterOrderSchema`) → reorder (400 `invalid_order` if the id set is not exactly the user's rules) → sync |
| `POST /filters/sync` | re-run sync (retry button); 200 `{ status: "ok" | "skipped" }` or 502 |
| `GET /vacation` | current settings (defaults if unset) |
| `PUT /vacation` | validate (`vacationSettingsInputSchema`) → upsert → sync |

Sync semantics (design §4): sync runs INSIDE the mutation, best-effort — `skipped` when JMAP is not configured or the user has no mailbox credential (CRUD still works, like signatures); `failed`/`invalid` → the DB write STAYS and the response is 502 `sieve_sync_failed` / `sieve_invalid`. A credential row that exists but fails to decrypt is `failed`, NOT `skipped` (never mask broken credentials — F2 lesson).

**Route order matters:** register `PUT /filters/order` and `POST /filters/sync` BEFORE `/filters/:id` routes so `order`/`sync` are not captured as `:id`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/modules/sieve/router.test.ts` (bootstrap copied from `signatures.test.ts`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createFilterRulesRepo } from "../../infra/repos/filter-rules";
import { createVacationSettingsRepo } from "../../infra/repos/vacation-settings";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createSieveRouter } from "./router";
import { DomainError } from "../../core/errors";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let filterRules: ReturnType<typeof createFilterRulesRepo>;
let vacationSettings: ReturnType<typeof createVacationSettingsRepo>;
let token: string;
let token2: string;
let userId: string;

const ruleBody = {
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "fileinto", folder: "Invoices" }],
  enabled: true,
};

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  filterRules = createFilterRulesRepo(sql);
  vacationSettings = createVacationSettingsRepo(sql);
  sessions = createSessionStore(sql);

  const user1 = await users.create({
    email: `sieve-r1-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 1",
  });
  userId = user1.id;
  token = (await sessions.create(user1.id, 1)).token;

  const user2 = await users.create({
    email: `sieve-r2-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "Sieve Router User 2",
  });
  token2 = (await sessions.create(user2.id, 1)).token;
});
afterAll(() => sql.end());

function makeApp(jmap: JmapClient | null) {
  return createApp({
    sieveRouter: createSieveRouter({
      sessions,
      mailCredentials,
      filterRules,
      vacationSettings,
      jmap,
    }),
  });
}

function stubJmap(): { client: JmapClient; uploads: string[] } {
  const uploads: string[] = [];
  const session: JmapSession = {
    apiUrl: "http://stalwart/jmap/api",
    accountId: "acc1",
    eventSourceUrl: "",
    uploadUrl: "http://stalwart/upload/{accountId}/",
    downloadUrl: "",
  };
  const client = {
    async getSession() {
      return session;
    },
    async request(_auth: unknown, _session: unknown, calls: JmapMethodCall[]) {
      const [method] = calls[0]!;
      if (method === "Mailbox/get") {
        return [["Mailbox/get", { list: [{ name: "Papelera", role: "trash" }] }, "0"]];
      }
      if (method === "SieveScript/get") {
        return [["SieveScript/get", { list: [] }, "0"]];
      }
      if (method === "SieveScript/validate") {
        return [["SieveScript/validate", { error: null }, "0"]];
      }
      return [[method, {}, "0"]];
    },
    async uploadBlob(_auth: unknown, _session: unknown, content: string) {
      uploads.push(content);
      return "blob1";
    },
  } as unknown as JmapClient;
  return { client, uploads };
}

function brokenJmap(): JmapClient {
  return {
    async getSession() {
      throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
    },
    async request() {
      throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
    },
    async uploadBlob() {
      throw new DomainError("stalwart_unavailable", 502, "errors.stalwart_unavailable");
    },
  } as unknown as JmapClient;
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown, cookie = token) {
  return app.request(path, {
    method: "POST",
    headers: { cookie: `session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(app: ReturnType<typeof makeApp>, path: string, body: unknown, cookie = token) {
  return app.request(path, {
    method: "PUT",
    headers: { cookie: `session=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sieve routes", () => {
  it("requires a session", async () => {
    const res = await makeApp(null).request("/api/mail/filters");
    expect(res.status).toBe(401);
  });

  it("rejects invalid rule bodies", async () => {
    const res = await post(makeApp(null), "/api/mail/filters", { name: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("does full CRUD without JMAP configured (sync skipped)", async () => {
    const app = makeApp(null);
    const createRes = await post(app, "/api/mail/filters", ruleBody);
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("invoices");

    const listRes = await app.request("/api/mail/filters", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as { id: string }[];
    expect(list.some((r) => r.id === created.id)).toBe(true);

    const updateRes = await put(app, `/api/mail/filters/${created.id}`, {
      ...ruleBody,
      name: "renamed",
    });
    expect(updateRes.status).toBe(200);

    const foreignRes = await put(
      app,
      `/api/mail/filters/${created.id}`,
      { ...ruleBody, name: "hijack" },
      token2,
    );
    expect(foreignRes.status).toBe(404);

    const orderRes = await put(app, "/api/mail/filters/order", { ids: [created.id] });
    expect(orderRes.status).toBe(200);

    const badOrderRes = await put(app, "/api/mail/filters/order", {
      ids: [crypto.randomUUID()],
    });
    expect(badOrderRes.status).toBe(400);
    expect(((await badOrderRes.json()) as { code: string }).code).toBe("invalid_order");

    const deleteRes = await app.request(`/api/mail/filters/${created.id}`, {
      method: "DELETE",
      headers: { cookie: `session=${token}` },
    });
    expect(deleteRes.status).toBe(200);
  });

  it("syncs the generated script when JMAP works", async () => {
    await mailCredentials.set(userId, "mailbox-pw");
    const { client, uploads } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters", {
      ...ruleBody,
      name: "synced rule",
      actions: [{ type: "delete" }],
    });
    expect(res.status).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain("# rule: synced rule");
    expect(uploads[0]).toContain('fileinto "Papelera";');
  });

  it("returns sieve_sync_failed but keeps the rule when Stalwart is down", async () => {
    const app = makeApp(brokenJmap());
    const res = await post(app, "/api/mail/filters", { ...ruleBody, name: "pending rule" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("sieve_sync_failed");

    const listRes = await makeApp(null).request("/api/mail/filters", {
      headers: { cookie: `session=${token}` },
    });
    const list = (await listRes.json()) as { name: string }[];
    expect(list.some((r) => r.name === "pending rule")).toBe(true);
  });

  it("reapplies filters on demand", async () => {
    const { client, uploads } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters/sync", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
    expect(uploads).toHaveLength(1);
  });

  it("reports skipped when the user has no mailbox credential", async () => {
    const { client } = stubJmap();
    const res = await post(makeApp(client), "/api/mail/filters/sync", {}, token2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("skipped");
  });

  it("reads default vacation settings and round-trips an update", async () => {
    const app = makeApp(null);
    const getRes = await app.request("/api/mail/vacation", {
      headers: { cookie: `session=${token2}` },
    });
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { enabled: boolean }).enabled).toBe(false);

    const putRes = await put(
      app,
      "/api/mail/vacation",
      {
        enabled: true,
        subject: "Out",
        message: "Away until the 20th",
        startsAt: "2026-07-10",
        endsAt: "2026-07-20",
        intervalDays: 3,
      },
      token2,
    );
    expect(putRes.status).toBe(200);
    expect(((await putRes.json()) as { startsAt: string }).startsAt).toBe("2026-07-10");
  });

  it("rejects enabled vacation with a blank message", async () => {
    const res = await put(makeApp(null), "/api/mail/vacation", {
      enabled: true,
      message: "   ",
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run test -- src/modules/sieve/router.test.ts`
Expected: FAIL — cannot resolve `./router` / `createApp` has no `sieveRouter`.

- [ ] **Step 3: Implement** — `apps/server/src/modules/sieve/router.ts`:

```ts
import { Hono } from "hono";
import {
  filterOrderSchema,
  filterRuleInputSchema,
  vacationSettingsInputSchema,
} from "@webmail/shared";
import { DomainError } from "../../core/errors";
import type { FilterRulesRepo } from "../../infra/repos/filter-rules";
import type { VacationSettingsRepo } from "../../infra/repos/vacation-settings";
import { requireSession } from "../auth/middleware";
import type { MailDeps, MailVariables } from "../mail/context";
import { syncSieveScript } from "./sync";

export type SieveDeps = {
  sessions: MailDeps["sessions"];
  mailCredentials: MailDeps["mailCredentials"];
  filterRules: FilterRulesRepo;
  vacationSettings: VacationSettingsRepo;
  jmap: MailDeps["jmap"];
};

type SyncOutcome = "ok" | "skipped" | "failed" | "invalid";

async function trySync(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<SyncOutcome> {
  if (!deps.jmap) return "skipped";
  let password: string | null;
  try {
    password = await deps.mailCredentials.get(user.userId);
  } catch {
    return "failed";
  }
  if (password === null) return "skipped";
  try {
    const auth = { email: user.email, password };
    const session = await deps.jmap.getSession(auth);
    const [rules, vacation] = await Promise.all([
      deps.filterRules.list(user.userId),
      deps.vacationSettings.get(user.userId),
    ]);
    await syncSieveScript({ jmap: deps.jmap, auth, session, rules, vacation });
    return "ok";
  } catch (error) {
    if (error instanceof DomainError && error.code === "sieve_invalid") {
      return "invalid";
    }
    return "failed";
  }
}

export function createSieveRouter(deps: SieveDeps) {
  const router = new Hono<{ Variables: MailVariables }>();

  router.use("*", requireSession(deps.sessions));

  const syncError = (c: Parameters<Parameters<typeof router.get>[1]>[0], outcome: "failed" | "invalid") => {
    const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
    return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
  };

  router.get("/filters", async (c) => {
    const user = c.get("user");
    return c.json(await deps.filterRules.list(user.userId));
  });

  router.post("/filters/sync", async (c) => {
    const user = c.get("user");
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      return syncError(c, outcome);
    }
    return c.json({ status: outcome });
  });

  router.put("/filters/order", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = filterOrderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const reordered = await deps.filterRules.reorder(user.userId, parsed.data.ids);
    if (!reordered) {
      return c.json(
        { code: "invalid_order", message: "errors.invalid_order", traceId: c.get("traceId") },
        400,
      );
    }
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      return syncError(c, outcome);
    }
    return c.json({ ok: true });
  });

  router.post("/filters", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = filterRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const created = await deps.filterRules.create(user.userId, parsed.data);
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      return syncError(c, outcome);
    }
    return c.json(created);
  });

  router.put("/filters/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = filterRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const updated = await deps.filterRules.update(user.userId, id, parsed.data);
    if (!updated) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      return syncError(c, outcome);
    }
    return c.json(updated);
  });

  router.delete("/filters/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const removed = await deps.filterRules.remove(user.userId, id);
    if (!removed) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      return syncError(c, outcome);
    }
    return c.json({ ok: true });
  });

  router.get("/vacation", async (c) => {
    const user = c.get("user");
    return c.json(await deps.vacationSettings.get(user.userId));
  });

  router.put("/vacation", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = vacationSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const saved = await deps.vacationSettings.set(user.userId, parsed.data);
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      return syncError(c, outcome);
    }
    return c.json(saved);
  });

  return router;
}
```

Notes for the implementer:
- If the `syncError` helper's context type fights Hono's generics, inline the two-line error response in each route instead — behavior over cleverness.
- If `DomainError` exposes its code under a different property than `.code`, use the real one (check `apps/server/src/core/errors.ts`).
- In `apps/server/src/app.ts`, add `sieveRouter` to the deps type as OPTIONAL (matching how `mailRouter` is declared) and mount it: `if (deps.sieveRouter) app.route("/api/mail", deps.sieveRouter);` — mirror the exact existing style.
- In `apps/server/src/index.ts`, construct the two repos and `createSieveRouter({ sessions, mailCredentials, filterRules, vacationSettings, jmap })` reusing the SAME instances already built for the mail router.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun run test -- src/modules/sieve/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the FULL server suite + typecheck**

Run: `cd apps/server && bun run test` — Expected: PASS (no regression in mail/auth/admin suites).
Run: `cd apps/server && bun run typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/sieve/router.ts apps/server/src/modules/sieve/router.test.ts apps/server/src/app.ts apps/server/src/index.ts
git commit -m "feat(sieve): filters and vacation endpoints with best-effort sync"
```
