async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Constant-time equality for a supplied secret against the configured one.
 *
 * Both sides are hashed first (the same trick auth/sessions.ts uses to store a
 * session token) so the comparison always runs over two fixed 32-byte digests:
 * a plain string compare would leak the length of the secret and how many of
 * its leading characters a guess got right, and the loop below deliberately has
 * no early exit.
 *
 * Extracted from core/metrics.ts for GH #346. It was the one place in the
 * codebase doing this properly, while setup/bootstrap.ts compared the two hex
 * digests of the SAME break-glass credential with `===` — a compare that returns
 * sooner the fewer leading hex characters match. Hashing does blunt that (a
 * guess has to move the digest, not the password), but the two call sites now
 * share one implementation instead of one of them getting it right by accident.
 */
export async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
