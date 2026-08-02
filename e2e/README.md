# End-to-end suite

Playwright drives the real SPA against the real app server, a real Postgres and
— for the mail specs — the pre-provisioned Stalwart fixture in
[`stalwart/`](stalwart/README.md). `playwright.config.ts` starts everything it
needs; see its comments for the server topology (three app servers and a
purpose-built OIDC provider, each with a reason).

## Running it

```sh
# Postgres is mandatory: the suite creates a throwaway sibling database from
# this URL and drops it afterwards. It never falls back to a shared one.
export DATABASE_URL=postgres://webmail:webmail@localhost:5434/postgres

# Mail specs additionally need the Stalwart fixture:
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
docker compose -f docker-compose.e2e.yml up -d --build
export E2E_STALWART_URL=http://localhost:8096

cd e2e && bunx playwright test
```

## Projects, and which server each one drives

Three app servers run from the same binary; what separates them is the state
they are in, because some screens only exist in one of those states.

| project    | server                | why it needs its own                                                                                                   |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `chromium` | bootstrap mode, seeded | The signed-in product. Everything that is not one of the two below.                                                      |
| `sso`      | bootstrap mode OFF     | LoginPage only offers the SSO button when `/api/auth/mode` reports `bootstrapMode: false`, so the production entry point is unreachable on the default server (GH #217). |
| `setup`    | its own empty database | The first-run wizard is closed for good once an admin and an SSO config exist (GH #234), and `global-setup.ts` creates both — so a first run needs a database it never touched (GH #248). |

Each `setup`/`sso` server costs a process and a migration, which is the price of
covering a screen that is defined by the instance state it appears in.

## What is not covered yet

Recorded rather than half-covered (GH #248), roughly in risk order:

- **Sieve/filter rules end to end.** `FilterRuleForm.tsx` is the web package's
  weakest branch coverage, and the generator it feeds is injection-sensitive.
  Needs the Stalwart fixture's ManageSieve path, so it is a bigger piece of work
  than the two specs above.
- **Signatures and vacation replies.** Both mutate what outbound mail looks like;
  both are covered at the unit level and unproven against a real Stalwart.
- **Attachments.** Upload and download round trips through JMAP.
- **The AI surfaces.** Need a stubbed provider before a spec means anything.
- **The admin SSO save.** Deliberately left out of `admin-mutations.spec.ts`: it
  writes the same `sso_config` row the `sso` project logs in through, and the
  two projects have no ordering guarantee between them. The wizard spec covers
  that write path instead, on a database of its own.

## The harness's own tests

`smtp-seed.ts`, `oidc-idp.ts` and `test-db.ts` decide whether a Playwright run
proves anything, so they have unit tests of their own (`*.test.ts` in this
directory, under `bun test`). They need neither Postgres nor a browser, and they
are part of both the repo-wide `bun run test` and, since GH #247, `bun run
coverage` — see `bunfig.toml` for the floor and why it is set where it is.

Both scripts pass `.test.ts` as a filter rather than running bare `bun test`:
Bun's default discovery also matches `*.spec.ts`, which would sweep up the
Playwright specs in `tests/` and fail on the first `@playwright/test` import.
The filter is a substring match on the path, so a new `*.test.ts` file here is
picked up automatically — unlike the previous hardcoded single filename, which
is how `smtp-seed.test.ts` went unrun for a while (GH #216).

## Retries and flaky specs

CI runs with `retries: 1`; locally there are no retries at all. That tolerance
exists for infrastructure noise — a container that answers a millisecond after
its health probe, a registry hiccup — and it is deliberately not zero, because
a suite that goes red on the first bad DNS lookup stops being read.

The cost of that tolerance is that a spec which fails half the time and passes
on the retry produces a **green job**. Nothing about the run says otherwise
unless somebody opens the log. So every retry is recorded (GH #246), by
`retry-reporter.ts`, on three surfaces:

- a `::warning::` annotation per retried spec, on the run's annotations;
- an **e2e retries** table in the job summary, which outlives the log;
- `e2e/test-results/retries.json`, uploaded as the **`e2e-retries`** artifact on
  every run — including runs where nothing retried, so a missing artifact means
  a broken upload rather than a clean suite.

### The policy

1. **A retry is a defect report, not a shrug.** The first time a spec appears in
   the retries artifact, look at the recorded first-failure line. Infrastructure
   noise and a genuine race read very differently there.
2. **Twice, on separate commits, ends the tolerance.** A spec that retries on two
   unrelated commits is unstable, whatever the cause looks like. Open an issue
   with the artifact rows attached, and then either
   - **fix it** — the usual causes are an assertion racing an unawaited
     mutation, or a fixture asserted before it is seeded; or
   - **mark it** — `test.fixme()` with the issue number in the title, so it stops
     consuming a retry budget and stops contributing a false green.

   What is not an option is leaving it retrying: that is the state this
   machinery exists to make impossible to sit in unnoticed.
3. **Raising `retries` is not a fix.** The number is 1 and stays 1. A spec that
   needs two retries needs an owner.
4. **A quarantined spec is a debt with a name.** `test.fixme` without an issue
   number is just a deletion that still looks like coverage.
