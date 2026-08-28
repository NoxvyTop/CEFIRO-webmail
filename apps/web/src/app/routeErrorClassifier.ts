// GH #345: after a deploy, a hashed chunk (Composer, Settings, pdfjs) that a
// still-open tab tries to lazy-import 404s, because that exact filename no
// longer exists on the server (a fresh deploy produced new hashes). Every
// browser phrases the resulting rejection differently, so recognising only
// Chrome's exact string would leave most visitors on the generic fallback
// instead of the actionable "reload" message.
const CHUNK_LOAD_FAILURE_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chrome, Vite's own wording
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  // The plain network failure a stale-chunk 404 can also surface as (Vite's
  // manual chunks — react-vendor, tiptap, pdfjs — reached via a bare fetch
  // rather than an import() in some browsers/edge cases).
  /failed to fetch/i,
];

/**
 * True when `error` looks like a stale hashed-chunk load failure rather than
 * an ordinary application bug — the one case RouteError (and the top-level
 * AppErrorBoundary) offer a specific "reload" framing for.
 */
export function isChunkLoadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(error.message));
}
