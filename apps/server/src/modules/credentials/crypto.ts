const ALGO = "AES-GCM";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export async function importMasterKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, ALGO, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: new Uint8Array(encrypted), iv };
}

export async function decryptSecret(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(new Uint8Array(plain));
}
