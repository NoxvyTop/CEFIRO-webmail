import { log } from "./logger";

/**
 * Cross-site request forgery defence for every mutating request (GH #335).
 *
 * The session cookie is the only credential this API accepts on a browser
 * route (modules/auth/middleware.ts), and it is `SameSite=Lax`. Lax stops a
 * cross-SITE POST, but "site" is the registrable domain: a sibling subdomain
 * — `intranet.example.com` against `mail.example.com`, or an XSS on any host
 * under the same domain — is same-site, so the browser attaches the cookie and
 * every mutation this API exposes becomes reachable. `PUT /api/mail/filters/raw`
 * is the sharpest of them: raw Sieve accepts `redirect`, which is silent
 * exfiltration of all future mail.
 *
 * There is no token to compare here on purpose. A synchroniser token needs a
 * place to live (a second cookie, or a value rendered into the SPA shell) and a
 * rotation story, and it buys nothing over the two headers below, which the
 * browser sets itself and page JavaScript cannot forge: `Origin` and `Referer`
 * are forbidden header names for `fetch`/XHR, and `Sec-Fetch-*` is set by the
 * network stack after the page has had its say.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `same-origin` is the SPA talking to its own API. `none` is a request the user
 * started themselves — typing a URL, a bookmark — which a page cannot cause: a
 * form submission or `fetch()` from any document is always classified
 * `same-origin`, `same-site` or `cross-site`. Note `same-site` is deliberately
 * NOT here; it is precisely the sibling-subdomain case above.
 */
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

export type CsrfDecision =
  | { allowed: true }
  | { allowed: false; status: 403; code: "csrf"; reason: string }
  | { allowed: false; status: 415; code: "unsupported_media_type"; reason: string };

const ALLOWED = { allowed: true } as const;

/** The slice of a Hono request this needs; structural so tests can drive it. */
type CsrfRequest = {
  method: string;
  url: string;
  path: string;
  header(name: string): string | undefined;
  hasBody: boolean;
};

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** `application/json; charset=utf-8` -> `application/json`. */
function mediaType(header: string | undefined): string {
  const [type = ""] = (header ?? "").split(";", 1);
  return type.trim().toLowerCase();
}

/**
 * Decides whether a request may mutate. Split out of the middleware so the rule
 * is a pure function of the headers and can be reasoned about on its own.
 *
 * @param expectedOrigin the origin of `APP_URL`, or undefined to fall back to
 *   the origin the request itself was addressed to.
 * @param binaryPaths paths that legitimately carry a non-JSON body and are
 *   therefore exempt from the media-type check only (never from the origin one).
 */
export function csrfDecision(
  req: CsrfRequest,
  expectedOrigin: string | undefined,
  binaryPaths: ReadonlySet<string>,
): CsrfDecision {
  if (SAFE_METHODS.has(req.method)) return ALLOWED;

  const fetchSite = req.header("sec-fetch-site")?.toLowerCase();
  // A modern browser answers here. Everything below is the compatibility path
  // for the ones that do not send Fetch Metadata (Safari < 16.4, older
  // WebViews), which still send `Origin` on every mutating request.
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return { allowed: false, status: 403, code: "csrf", reason: `sec-fetch-site:${fetchSite}` };
  }

  if (!fetchSite) {
    // `expectedOrigin` is APP_URL's. Falling back to the request's own origin
    // keeps the rule meaningful for a deployment that never set APP_URL and for
    // every test that builds an app without one: an attacker's page still sends
    // ITS origin, not the one it is aiming at, so the comparison holds either way.
    const self = expectedOrigin ?? originOf(req.url);
    // Origin first; Referer only when the browser sent no Origin. Referer can be
    // suppressed by a referrer policy, which is why it cannot be the primary
    // signal — but when it IS present its origin is equally unforgeable.
    const claimed = originOf(req.header("origin")) ?? originOf(req.header("referer"));
    if (!claimed) {
      // Neither Fetch Metadata, nor Origin, nor Referer: not a browser. Refused
      // rather than waved through, because this API has no route that both
      // mutates and authenticates with a bearer token — the cookie is the only
      // credential a mutation can carry, so an "API client" exemption here would
      // just be a hole with a comment on it. /metrics is bearer-authenticated but
      // is a GET, and so never reaches this branch. A non-browser client that
      // must drive a mutation sends `Origin: <APP_URL>` (see docs/OPERATIONS.md).
      return { allowed: false, status: 403, code: "csrf", reason: "no origin headers" };
    }
    if (claimed !== self) {
      return { allowed: false, status: 403, code: "csrf", reason: "origin mismatch" };
    }
  }

  // Defence in depth behind the same gate (GH #335). A cross-site HTML form can
  // only produce three content types, none of them JSON; requiring JSON on the
  // routes that parse JSON means a forged form submission is refused a second
  // time, by a rule that does not depend on any header the browser adds.
  //
  // Keyed on the presence of a body, not on the method: the SPA sends several
  // body-less mutations (`POST /api/mail/filters/sync`, `POST /api/auth/logout`,
  // `DELETE /api/mail/signatures/:id`), and those carry no content type at all.
  if (req.hasBody && !binaryPaths.has(req.path)) {
    const type = mediaType(req.header("content-type"));
    if (type !== "application/json") {
      return {
        allowed: false,
        status: 415,
        code: "unsupported_media_type",
        reason: type || "absent",
      };
    }
  }

  return ALLOWED;
}

/** One warn line per refusal: the route and the reason, never the body. */
export function logCsrfRefusal(entry: {
  traceId: string;
  method: string;
  route: string;
  status: number;
  reason: string;
}): void {
  log("warn", "csrf refused", entry);
}
