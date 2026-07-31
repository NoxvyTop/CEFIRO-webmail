// Serve a stored avatar (an `image/{png,jpeg,webp}` base64 data URL) as a
// cacheable HTTP resource instead of embedding it in a JSON payload (GH #205).
// Shared by the admin console (any user, admin-only) and the profile endpoint
// (the caller's own avatar) so both surfaces produce identical caching
// semantics from one place.

// Raster-only allowlist, mirroring the upload validator
// (packages/shared/src/api/profile.ts): png/jpeg/webp, base64. Anything else
// that somehow reached storage is treated as "nothing to serve" (→ 404).
const AVATAR_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;

// Stable per-user URL + always-revalidate: the browser keeps the bytes and, on
// the next load, sends If-None-Match and gets a tiny 304 instead of
// re-downloading the image. `private` because the bytes sit behind auth (the
// admin console, or the user's own session) and must never be stored by a
// shared/proxy cache.
export const AVATAR_CACHE_CONTROL = "private, max-age=0, must-revalidate";

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  // Stays on Web Crypto / global primitives (no node:Buffer). Allocate over a
  // concrete ArrayBuffer so the bytes satisfy BufferSource/BodyInit — a plain
  // `Uint8Array.from(...)` infers ArrayBufferLike, which lib.dom rejects.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Weak comparison per RFC 9110 §8.8.3.2: strip an optional `W/` prefix and
// match any of the comma-separated client validators (or `*`) against ours.
function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const ours = normalize(etag);
  return header.split(",").some((token) => normalize(token) === ours);
}

/**
 * Builds the HTTP response for an avatar stored as a data URL (GH #205):
 * a cacheable image carrying a strong content ETag, a 304 when the client's
 * If-None-Match still matches, or `null` when there is nothing to serve (no
 * avatar, or an unparseable value) so the caller can return its own 404.
 */
export async function avatarImageResponse(
  dataUrl: string | null | undefined,
  ifNoneMatch: string | undefined,
): Promise<Response | null> {
  if (!dataUrl) return null;
  const match = AVATAR_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return null;

  const contentType = match[1]!;
  const body = decodeBase64(match[2]!);
  // Strong content ETag: any change to the stored avatar changes the digest,
  // so a stale cache entry revalidates straight to a fresh 200.
  const etag = `"${await sha256Hex(body)}"`;

  if (ifNoneMatchSatisfied(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": AVATAR_CACHE_CONTROL },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      etag,
      "cache-control": AVATAR_CACHE_CONTROL,
    },
  });
}
