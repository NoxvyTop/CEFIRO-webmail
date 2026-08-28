import { aadFor, decryptSecret, encryptSecret } from "../credentials/crypto";

export const OIDC_STATE_COOKIE = "oidc_state";

// GH #347: binds this cookie to "this is the OIDC state cookie", so it cannot
// be replayed as a decryption of a differently-purposed ciphertext (a mail
// credential, the SSO client secret) even under the same master key.
const OIDC_STATE_AAD = aadFor("oidc_state");

export type OidcState = { state: string; verifier: string; issuedAt: number };

function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromB64Url(value: string): Uint8Array {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

export async function sealState(key: CryptoKey, data: OidcState): Promise<string> {
  const { ciphertext, iv } = await encryptSecret(key, JSON.stringify(data), OIDC_STATE_AAD);
  return `${toB64Url(iv)}.${toB64Url(ciphertext)}`;
}

export async function openState(
  key: CryptoKey,
  sealed: string,
  maxAgeMs = 600_000,
): Promise<OidcState | null> {
  try {
    const [ivPart, cipherPart] = sealed.split(".");
    if (!ivPart || !cipherPart) return null;
    const plain = await decryptSecret(key, fromB64Url(cipherPart), fromB64Url(ivPart), OIDC_STATE_AAD);
    const data = JSON.parse(plain) as OidcState;
    if (typeof data.state !== "string" || typeof data.verifier !== "string") return null;
    if (typeof data.issuedAt !== "number" || Date.now() - data.issuedAt > maxAgeMs) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
