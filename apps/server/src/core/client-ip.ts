/**
 * Who the client is, when everything this process sees arrived through a proxy
 * (GH #238).
 *
 * `X-Forwarded-For` is a list, and every entry in it is a claim. The only
 * entries worth anything are the ones a proxy WE control appended; everything
 * to the left of those is whatever the client typed. Five call sites used to
 * read the header ad hoc — three took `split(",")[0]`, the LEFTMOST hop, and
 * two took the raw header verbatim — so under any appending proxy (nginx's
 * `$proxy_add_x_forwarded_for`, which is the documented topology) the value
 * that became the rate-limit key and the audit `ip` column was supplied by the
 * caller. Rotating one header defeated all five limiters at once, including the
 * one that bounds guessing against the `/metrics` token, and filled the audit
 * log with addresses of the attacker's choosing.
 *
 * The fix is a contract instead of a guess: the operator declares HOW MANY
 * proxies append to the header (`TRUSTED_PROXY_HOPS`, see core/config.ts), and
 * the client is read by counting that many entries from the RIGHT — the end a
 * client cannot reach, because every trusted hop appends after whatever it was
 * handed. See docs/OPERATIONS.md → "Proxies de confianza" for the deployment
 * side of the same contract.
 */

/**
 * Number of proxies that append to `X-Forwarded-For` between the internet and
 * this process, when nothing says otherwise.
 *
 * One, because that is the topology this repository documents and ships for: a
 * single reverse proxy terminating TLS in front of the container (see
 * docs/OPERATIONS.md and docker-cefiro). Zero would be the paranoid default,
 * but it is the wrong one here — with no trusted hop there is no client to
 * attribute anything to, so every caller in the world would share ONE bucket
 * and a single flood would lock the operator out of the break-glass login. A
 * deployment that really does expose this process directly sets 0 explicitly
 * and accepts that its ceilings become global.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/**
 * The bucket every request whose client cannot be attributed shares.
 *
 * Deliberately ONE shared bucket rather than a per-request key: the whole point
 * is that these requests carry no identity we are willing to believe, and
 * minting a key from an unbelievable value is the defect this module exists to
 * close. In the documented topology the only thing that lands here is the
 * container's own HEALTHCHECK, which connects on loopback and sends no header.
 */
export const UNATTRIBUTED_CLIENT = "unattributed";

/**
 * Longest string accepted as an address. A full IPv6 with an embedded IPv4 and
 * a zone index is 45 characters; nothing legitimate is longer. This bounds what
 * a MISCONFIGURED deployment (fewer real proxy hops than declared) can push
 * into a rate-limiter key or an audit row — in a correct one the value was
 * written by our own proxy and needs no bounding.
 */
const MAX_ADDRESS_LENGTH = 45;

/** The minimum this needs from a Hono context, so tests need no Hono. */
export type ForwardedForSource = { req: { header(name: string): string | undefined } };

const FORWARDED_FOR_HEADER = "x-forwarded-for";

/**
 * The entry `trustedProxyHops` places from the right of the chain, or
 * `undefined` when there is no such entry.
 *
 * A chain SHORTER than the declared hop count means the request did not travel
 * the path the operator described — it reached this process without passing
 * every trusted proxy — so there is nothing here to attribute and the caller
 * falls back to the shared bucket. That is the direction the failure has to
 * lean: an attacker who strips or shortens the header must land in the shared
 * bucket, never in a bucket of their own choosing.
 */
function attribute(forwardedFor: string | undefined, trustedProxyHops: number): string | undefined {
  if (trustedProxyHops <= 0 || !forwardedFor) return undefined;
  const chain = forwardedFor.split(",");
  const index = chain.length - trustedProxyHops;
  if (index < 0) return undefined;
  const candidate = chain[index]?.trim() ?? "";
  if (candidate === "" || candidate.length > MAX_ADDRESS_LENGTH) return undefined;
  return candidate;
}

/**
 * The client address for this request, or `undefined` when it cannot be
 * attributed. Use this for anything RECORDED (the audit `ip` column), where
 * "we do not know" has to stay distinguishable from a real address.
 */
export function clientIp(
  c: ForwardedForSource,
  trustedProxyHops: number,
): string | undefined {
  return attribute(c.req.header(FORWARDED_FOR_HEADER), trustedProxyHops);
}

/**
 * The rate-limit key for this request. Same attribution as `clientIp`, with the
 * shared bucket standing in for "unknown" — a limiter needs a key for every
 * request, and the one thing it must never do is hand out a fresh key per
 * unverifiable header value.
 */
export function rateLimitKey(c: ForwardedForSource, trustedProxyHops: number): string {
  return clientIp(c, trustedProxyHops) ?? UNATTRIBUTED_CLIENT;
}
