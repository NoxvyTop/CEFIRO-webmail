/**
 * How many worker slots the server test suite runs on — and, by construction,
 * how many throwaway databases vitest.global-setup.ts provisions (GH #14).
 *
 * It lives in its own module because vitest.config.ts and vitest.global-setup.ts
 * both need it and neither may import the other: the config would execute the
 * setup module, and the setup module is named by the config as a path.
 *
 * Pinned rather than derived from the CPU count. The databases are minted
 * up front, one per slot, so the number has to be known before any worker
 * exists — a machine-dependent count would mean provisioning for a number the
 * run might exceed, and a worker without its own database refuses to run
 * (deliberately: silently sharing one is exactly the GH #14 failure).
 *
 * Eight is a compromise, not a maximum. The ceiling that matters here is the
 * database's, not the machine's: each concurrent file opens its own Postgres
 * pools (infra/db/client.ts, `max: 10` each, several per file) against one
 * server whose stock `max_connections` is 100. Eight leaves real headroom under
 * that, and takes the suite from ~39s serial to ~15s; twelve measured no
 * faster, because provisioning one more database costs about what the extra
 * concurrency saves.
 *
 * These tests wait on Postgres far more than on the CPU, so a runner with fewer
 * than eight cores still gains — raise or lower it on measurement, not on core
 * count, and re-measure the connection headroom if the pools ever grow.
 */
export const TEST_WORKER_COUNT = 8;
