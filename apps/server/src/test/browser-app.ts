import { createApp, type CreateAppOptions } from "../app";

/**
 * Test-only seam: an app that answers the way it does to a real browser,
 * because it adds the request header every browser sends and Hono's
 * `app.request()` never does.
 *
 * Why this exists (GH #335). The CSRF gate in core/csrf.ts refuses any mutating
 * request that carries no `Sec-Fetch-Site`, no `Origin` and no `Referer`, on the
 * grounds that no such client exists for a cookie-authenticated route. Hono's
 * `app.request()` is exactly such a client: it builds a bare `Request`, so every
 * mutating test in this package became a 403 the moment the gate landed.
 *
 * The alternative was a header literal at each of the ~143 mutating
 * `app.request(...)` call sites across 25 files — a change large enough to hide
 * anything else in the diff, and one every test written afterwards would have to
 * repeat correctly. Swapping the import instead is one line per file, and the
 * aliased name at the import states what those tests now are: a browser on the
 * app's own origin. Tests that drive the gate itself (csrf.test.ts) keep
 * importing the real `createApp` and set the headers they mean to test.
 *
 * It deliberately does NOT fill in `Content-Type`. A test that sends a body says
 * what type it is, exactly as the SPA does, so the 415 half of the gate stays
 * observable from the existing suite instead of being papered over here.
 */
/** Never overwrites: a test that sets the header is making a point about it. */
function browserHeaders(source: HeadersInit | undefined): Headers {
  const headers = new Headers(source);
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  return headers;
}

export function createBrowserApp(options: CreateAppOptions = {}) {
  const app = createApp(options);
  return {
    async request(input: string | Request, init?: RequestInit): Promise<Response> {
      // A prebuilt Request has to be rebuilt rather than handed an init object:
      // Hono constructs a fresh Request from `init` when one is given, which
      // drops whatever the caller put on the original (a cookie, an abort
      // signal). `new Request(req, { headers })` keeps both.
      if (input instanceof Request) {
        return app.request(new Request(input, { headers: browserHeaders(input.headers) }));
      }
      return app.request(input, { ...init, headers: browserHeaders(init?.headers) });
    },
  };
}
