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

// --- Key rotation -----------------------------------------------------------
//
// Every encrypted row stores the `key_version` it was sealed with. A keyring
// holds the current key — the only one that ever encrypts — plus the retired
// keys still needed to read rows that have not been re-encrypted yet. Rotating
// the master key is therefore: promote a new key to current, keep the old one
// listed as retired, and let reads migrate rows progressively.

/** Version stamped by deployments that never rotated: one key, all rows at 1. */
export const DEFAULT_KEY_VERSION = 1;

export type Keyring = {
  /** The only key that encrypts; its version is stamped on every new row. */
  readonly current: { readonly version: number; readonly key: CryptoKey };
  /** Retired keys, indexed by the `key_version` their rows still carry. */
  readonly previous: ReadonlyMap<number, CryptoKey>;
};

export type SealedSecret = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
};

/**
 * Thrown when a row carries a `key_version` the keyring has no key for. Naming
 * the version is the whole point: it tells the operator which retired key is
 * missing from the configuration.
 */
export class UnknownKeyVersionError extends Error {
  readonly version: number;

  constructor(version: number, known: number[]) {
    super(
      `no master key for key_version ${version}; keyring holds ${known.join(", ")}`,
    );
    this.name = "UnknownKeyVersionError";
    this.version = version;
  }
}

function assertValidVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`key version must be a positive integer, got ${version}`);
  }
}

export function createKeyring(
  current: { version: number; key: CryptoKey },
  previous: ReadonlyMap<number, CryptoKey> = new Map(),
): Keyring {
  assertValidVersion(current.version);
  for (const version of previous.keys()) {
    assertValidVersion(version);
    if (version === current.version) {
      throw new Error(
        `key version ${version} is both current and retired; a version identifies exactly one key`,
      );
    }
  }
  return { current, previous: new Map(previous) };
}

/**
 * Accepts either a keyring or a bare key. A bare key is the pre-rotation
 * deployment that only ever set `MASTER_KEY`: one key, every row at version 1.
 */
export function asKeyring(keys: CryptoKey | Keyring): Keyring {
  if ("current" in keys && "previous" in keys) return keys;
  return createKeyring({ version: DEFAULT_KEY_VERSION, key: keys });
}

export function knownKeyVersions(keyring: Keyring): number[] {
  return [keyring.current.version, ...keyring.previous.keys()].sort((a, b) => a - b);
}

export function keyForVersion(keyring: Keyring, version: number): CryptoKey | null {
  if (version === keyring.current.version) return keyring.current.key;
  return keyring.previous.get(version) ?? null;
}

export async function encryptWithKeyring(
  keyring: Keyring,
  plaintext: string,
): Promise<SealedSecret> {
  const { ciphertext, iv } = await encryptSecret(keyring.current.key, plaintext);
  return { ciphertext, iv, keyVersion: keyring.current.version };
}

export async function decryptWithKeyring(
  keyring: Keyring,
  secret: SealedSecret,
): Promise<string> {
  const key = keyForVersion(keyring, secret.keyVersion);
  if (!key) {
    throw new UnknownKeyVersionError(secret.keyVersion, knownKeyVersions(keyring));
  }
  return decryptSecret(key, secret.ciphertext, secret.iv);
}
