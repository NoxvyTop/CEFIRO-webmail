import { describe, expect, it } from "vitest";
import {
  aadFor,
  asKeyring,
  createKeyring,
  decryptSecret,
  decryptWithKeyring,
  encryptSecret,
  encryptWithKeyring,
  importMasterKey,
  masterKeyWeakness,
} from "./crypto";

function randomKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

describe("credential crypto", () => {
  it("round-trips a secret", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "mailbox-password");
    expect(await decryptSecret(key, ciphertext, iv)).toBe("mailbox-password");
  });

  it("produces different ciphertexts for the same plaintext", async () => {
    const key = await importMasterKey(randomKeyB64());
    const a = await encryptSecret(key, "same");
    const b = await encryptSecret(key, "same");
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("fails on tampered ciphertext", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "secret");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    await expect(decryptSecret(key, ciphertext, iv)).rejects.toThrow();
  });

  it("fails with the wrong key", async () => {
    const keyA = await importMasterKey(randomKeyB64());
    const keyB = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(keyA, "secret");
    await expect(decryptSecret(keyB, ciphertext, iv)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importMasterKey(btoa("short"))).rejects.toThrow();
  });
});

// GH #347: rows are addressable by whoever can write ciphertext/iv/key_version
// into the table — a Postgres write access, not necessarily the master key —
// so nothing before this bound a ciphertext to WHO or WHAT it was sealed for.
// Moving row A's ciphertext/iv/key_version onto row B's key_version column
// decrypted cleanly under the shared master key; only the AAD tying decryption
// to the caller's own context (mail:<userId>, "sso", "oidc_state") can refuse
// that.
describe("AES-GCM additional authenticated data (GH #347)", () => {
  it("round-trips a secret bound to a context", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "mailbox-password", aadFor("mail:u1"));
    expect(await decryptSecret(key, ciphertext, iv, aadFor("mail:u1"))).toBe("mailbox-password");
  });

  it("refuses to decrypt under a different context (swapped-owner ciphertext)", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "victim-password", aadFor("mail:victim"));
    // An attacker who moved this row's ciphertext/iv onto their own user_id
    // must not have it decrypt under their own context.
    await expect(
      decryptSecret(key, ciphertext, iv, aadFor("mail:attacker")),
    ).rejects.toThrow();
  });

  it("still decrypts a legacy ciphertext sealed before AAD existed", async () => {
    // Rows written by encryptSecret(key, plaintext) with no third argument, i.e.
    // every row in the database before this change shipped. Reading them now
    // passes a context — the read side has no way to know a row is legacy in
    // advance — so the fallback below is what keeps them decryptable.
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "legacy-password");
    expect(await decryptSecret(key, ciphertext, iv, aadFor("mail:u1"))).toBe("legacy-password");
  });

  it("keyring helpers thread the context through encrypt and decrypt", async () => {
    const keyring = createKeyring({ version: 1, key: await importMasterKey(randomKeyB64()) });
    const sealed = await encryptWithKeyring(keyring, "sso-secret", aadFor("sso"));
    expect(await decryptWithKeyring(keyring, sealed, aadFor("sso"))).toBe("sso-secret");
    await expect(decryptWithKeyring(keyring, sealed, aadFor("oidc_state"))).rejects.toThrow();
  });
});

// GH #223. Length was the only property ever checked, so the key published in
// docker-compose.dev.yml validated in production and decrypted every stored
// credential.
describe("master key weakness", () => {
  const DEV_COMPOSE_KEY = "ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE=";

  it("names the dev compose key and where it is published", () => {
    expect(atob(DEV_COMPOSE_KEY)).toBe("dev-master-key-dev-master-key-01");
    expect(masterKeyWeakness(DEV_COMPOSE_KEY)).toMatch(/docker-compose\.dev\.yml/);
  });

  it("ignores surrounding whitespace when matching a published key", () => {
    expect(masterKeyWeakness(` ${DEV_COMPOSE_KEY} `)).toMatch(/docker-compose\.dev\.yml/);
  });

  it("rejects an all-zero key", () => {
    const zeroKey = btoa(String.fromCharCode(...new Uint8Array(32)));
    expect(masterKeyWeakness(zeroKey)).toMatch(/identical/);
  });

  it("rejects a key built by repeating a short pattern", () => {
    const repeated = btoa("ab".repeat(16));
    expect(masterKeyWeakness(repeated)).toBeTruthy();
  });

  it("rejects a typed passphrase that is not a published key", () => {
    const passphrase = btoa("Correct-Horse-Battery-Staple2026"); // exactly 32 chars
    expect(passphrase).not.toBe(DEV_COMPOSE_KEY);
    expect(masterKeyWeakness(passphrase)).toMatch(/printable ASCII/);
  });

  it("accepts generated keys", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(masterKeyWeakness(randomKeyB64())).toBeNull();
    }
  });

  it("says nothing about a key that is not valid base64 or not 32 bytes", async () => {
    // importMasterKey is what reports a malformed key, with a message about its
    // shape rather than its quality; this must not shadow that.
    expect(masterKeyWeakness("!!!not base64!!!")).toBeNull();
    expect(masterKeyWeakness(btoa("short"))).toBeNull();
    // 44 unpadded base64 characters decode to 33 bytes, not 32 — the right
    // length as a string, the wrong length as a key.
    expect(masterKeyWeakness("A".repeat(44))).toBeNull();
    await expect(importMasterKey("A".repeat(44))).rejects.toThrow(/32 bytes/);
  });
});

describe("credential keyring", () => {
  it("encrypts with the current key and stamps its version", async () => {
    const currentKey = await importMasterKey(randomKeyB64());
    const keyring = createKeyring({ version: 3, key: currentKey });

    const sealed = await encryptWithKeyring(keyring, "mailbox-password");

    expect(sealed.keyVersion).toBe(3);
    expect(await decryptSecret(currentKey, sealed.ciphertext, sealed.iv)).toBe(
      "mailbox-password",
    );
  });

  it("decrypts a secret sealed under a retired key version", async () => {
    const retiredKey = await importMasterKey(randomKeyB64());
    const currentKey = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(retiredKey, "old-password");
    const keyring = createKeyring(
      { version: 2, key: currentKey },
      new Map([[1, retiredKey]]),
    );

    expect(await decryptWithKeyring(keyring, { ciphertext, iv, keyVersion: 1 })).toBe(
      "old-password",
    );
  });

  it("names the missing version when no key covers the stored key_version", async () => {
    const keyring = createKeyring({
      version: 2,
      key: await importMasterKey(randomKeyB64()),
    });
    const { ciphertext, iv } = await encryptSecret(
      await importMasterKey(randomKeyB64()),
      "unreachable",
    );

    await expect(
      decryptWithKeyring(keyring, { ciphertext, iv, keyVersion: 7 }),
    ).rejects.toThrow(/7/);
  });

  it("re-seals a retired secret under the current version", async () => {
    const retiredKey = await importMasterKey(randomKeyB64());
    const currentKey = await importMasterKey(randomKeyB64());
    const keyring = createKeyring(
      { version: 2, key: currentKey },
      new Map([[1, retiredKey]]),
    );
    const old = await encryptSecret(retiredKey, "rotate-me");

    const plaintext = await decryptWithKeyring(keyring, { ...old, keyVersion: 1 });
    const resealed = await encryptWithKeyring(keyring, plaintext);

    expect(resealed.keyVersion).toBe(2);
    expect(
      await decryptWithKeyring(createKeyring({ version: 2, key: currentKey }), resealed),
    ).toBe("rotate-me");
  });

  it("treats a bare key as a single-key deployment at version 1", async () => {
    const key = await importMasterKey(randomKeyB64());
    const keyring = asKeyring(key);

    const sealed = await encryptWithKeyring(keyring, "legacy");

    expect(sealed.keyVersion).toBe(1);
    expect(await decryptWithKeyring(keyring, sealed)).toBe("legacy");
  });

  it("passes an existing keyring through unchanged", async () => {
    const keyring = createKeyring({
      version: 4,
      key: await importMasterKey(randomKeyB64()),
    });
    expect(asKeyring(keyring)).toBe(keyring);
  });

  it("rejects a keyring that lists the current version as retired", async () => {
    const key = await importMasterKey(randomKeyB64());
    expect(() => createKeyring({ version: 2, key }, new Map([[2, key]]))).toThrow(/2/);
  });

  it("rejects a key version below 1", async () => {
    const key = await importMasterKey(randomKeyB64());
    expect(() => createKeyring({ version: 0, key })).toThrow();
  });
});
